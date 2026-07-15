const express = require('express');
const path = require('path');
const pool = require('./db');

const app = express();
app.use(express.json());

// Serves everything inside the "public" folder as plain website files.
// So public/index.html becomes visible at your server's root URL.
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// THE "EXTERNAL" ACCOUNT
// Represents money entering/leaving the system from outside
// (like a bank's own clearing account). Deposits and withdrawals
// are really just transfers to/from this special account - this
// keeps double-entry accounting intact everywhere, no exceptions.
// ============================================
let externalAccountId = null;

async function ensureExternalAccount() {
  const existing = await pool.query(
    "SELECT id FROM accounts WHERE owner_name = 'External'"
  );
  if (existing.rows.length > 0) {
    externalAccountId = existing.rows[0].id;
  } else {
    const created = await pool.query(
      "INSERT INTO accounts (owner_name) VALUES ('External') RETURNING id"
    );
    externalAccountId = created.rows[0].id;
  }
  console.log('External account ready:', externalAccountId);
}

// ============================================
// CORE TRANSFER LOGIC (shared by /transfer, /deposit, /withdraw)
// Same 5-step process we built and tested earlier - idempotency check,
// row lock, balance check (unless skipped), write entries, commit.
// ============================================
async function executeTransfer({ idempotency_key, from_account_id, to_account_id, amount, skipBalanceCheck = false }) {
  const existing = await pool.query(
    'SELECT * FROM transactions WHERE idempotency_key = $1',
    [idempotency_key]
  );
  if (existing.rows.length > 0) {
    return { alreadyProcessed: true, transaction: existing.rows[0] };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [from_account_id]);

    if (!skipBalanceCheck) {
      const balanceResult = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END), 0)
         AS balance
         FROM ledger_entries WHERE account_id = $1`,
        [from_account_id]
      );
      const currentBalance = parseFloat(balanceResult.rows[0].balance);
      if (currentBalance < amount) {
        await client.query('ROLLBACK');
        return { insufficientBalance: true, available: currentBalance };
      }
    }

    const txnResult = await client.query(
      `INSERT INTO transactions (idempotency_key, status, amount, from_account_id, to_account_id)
       VALUES ($1, 'completed', $2, $3, $4) RETURNING *`,
      [idempotency_key, amount, from_account_id, to_account_id]
    );
    const transaction = txnResult.rows[0];

    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount)
       VALUES ($1, $2, 'debit', $3)`,
      [transaction.id, from_account_id, amount]
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount)
       VALUES ($1, $2, 'credit', $3)`,
      [transaction.id, to_account_id, amount]
    );

    await client.query('COMMIT');
    return { transaction };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================
// GET /accounts
// Lists every account with its live-calculated balance.
// The frontend uses this to build the dropdown menus and balance cards.
// ============================================
app.get('/accounts', async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM account_balances WHERE owner_name != 'External' ORDER BY owner_name"
  );
  res.json(result.rows);
});

// ============================================
// GET /transactions
// Lists the most recent transactions, with account names joined in
// (instead of just raw UUIDs), so the frontend can show a readable history.
// ============================================
app.get('/transactions', async (req, res) => {
  const result = await pool.query(`
    SELECT t.*, fa.owner_name AS from_name, ta.owner_name AS to_name
    FROM transactions t
    JOIN accounts fa ON fa.id = t.from_account_id
    JOIN accounts ta ON ta.id = t.to_account_id
    ORDER BY t.created_at DESC
    LIMIT 20
  `);
  res.json(result.rows);
});

// ============================================
// GET /accounts/:id/history
// The ledger entries (debit/credit lines) for one specific account -
// used by the "Live Ledger Feed" panel on the frontend.
// ============================================
app.get('/accounts/:id/history', async (req, res) => {
  const result = await pool.query(
    `SELECT le.*, le.amount AS entry_amount
     FROM ledger_entries le
     WHERE le.account_id = $1
     ORDER BY le.created_at DESC
     LIMIT 20`,
    [req.params.id]
  );
  res.json(result.rows);
});

// ============================================
// POST /transfer
// Moves money from one account to another.
// ============================================
app.post('/transfer', async (req, res) => {
  const { idempotency_key, from_account_id, to_account_id, amount } = req.body;
  if (!idempotency_key || !from_account_id || !to_account_id || !amount) {
    return res.status(400).json({ error: 'Missing required field' });
  }
  try {
    const result = await executeTransfer({ idempotency_key, from_account_id, to_account_id, amount });
    if (result.alreadyProcessed) {
      return res.status(200).json({ message: 'Already processed (idempotent replay)', transaction: result.transaction });
    }
    if (result.insufficientBalance) {
      return res.status(400).json({ error: 'Insufficient balance', available: result.available });
    }
    res.status(201).json({ message: 'Transfer successful', transaction: result.transaction });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Transfer failed', detail: err.message });
  }
});

// ============================================
// POST /deposit
// Adds money to an account, FROM the External account.
// No balance check needed - External represents the outside world,
// it can go as negative as it wants (that's expected and correct).
// ============================================
app.post('/deposit', async (req, res) => {
  const { idempotency_key, account_id, amount } = req.body;
  if (!idempotency_key || !account_id || !amount) {
    return res.status(400).json({ error: 'Missing required field' });
  }
  try {
    const result = await executeTransfer({
      idempotency_key,
      from_account_id: externalAccountId,
      to_account_id: account_id,
      amount,
      skipBalanceCheck: true,
    });
    if (result.alreadyProcessed) {
      return res.status(200).json({ message: 'Already processed (idempotent replay)', transaction: result.transaction });
    }
    res.status(201).json({ message: 'Deposit successful', transaction: result.transaction });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Deposit failed', detail: err.message });
  }
});

// ============================================
// POST /withdraw
// Removes money from an account, TO the External account.
// This one DOES check balance - a real account can't go negative.
// ============================================
app.post('/withdraw', async (req, res) => {
  const { idempotency_key, account_id, amount } = req.body;
  if (!idempotency_key || !account_id || !amount) {
    return res.status(400).json({ error: 'Missing required field' });
  }
  try {
    const result = await executeTransfer({
      idempotency_key,
      from_account_id: account_id,
      to_account_id: externalAccountId,
      amount,
    });
    if (result.alreadyProcessed) {
      return res.status(200).json({ message: 'Already processed (idempotent replay)', transaction: result.transaction });
    }
    if (result.insufficientBalance) {
      return res.status(400).json({ error: 'Insufficient balance', available: result.available });
    }
    res.status(201).json({ message: 'Withdrawal successful', transaction: result.transaction });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Withdrawal failed', detail: err.message });
  }
});

// Quick helper endpoint so we can actually see balances while testing
app.get('/accounts/:id/balance', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM account_balances WHERE account_id = $1',
    [req.params.id]
  );
  res.json(result.rows[0] || { balance: 0 });
});

const PORT = 3000;
ensureExternalAccount().then(() => {
  app.listen(PORT, () => console.log(`Ledger server running on port ${PORT}`));
});