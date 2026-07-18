const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const pool = require('./db');

const app = express();
app.use(express.json());

// Serves everything inside the "public" folder as plain website files.
// So public/index.html becomes visible at your server's root URL.
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// RATE LIMITING
// General limiter covers every route. Write limiter is looser than a
// typical production default (300/min) so the in-UI stress test and
// repeated demo clicks don't trip it - tightened for production you'd
// drop this to something like 30/min per IP.
// ============================================
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});
app.use(generalLimiter);

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
  return externalAccountId;
}

// ============================================
// VALIDATION HELPERS
// Amounts arrive as JSON numbers/strings from the client. We reject
// anything that isn't a clean positive value with <=2 decimal places
// BEFORE it reaches the DB, so bad input returns a clean 400 instead
// of tripping the `CHECK (amount > 0)` constraint and bubbling up as
// a generic 500. Money is still stored as NUMERIC(14,2) in Postgres -
// for a system handling real currency at scale you'd represent amount
// as integer minor units (paise/cents) end-to-end instead of floats.
// ============================================
function validateAmount(amount) {
  if (amount === undefined || amount === null || amount === '') {
    return { valid: false, error: 'Amount is required' };
  }
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    return { valid: false, error: 'Amount must be a valid number' };
  }
  if (n <= 0) {
    return { valid: false, error: 'Amount must be greater than 0' };
  }
  if (n > 10000000) {
    return { valid: false, error: 'Amount exceeds maximum allowed (1,00,00,000)' };
  }
  if (Math.round(n * 100) !== Math.round(n * 100)) {
    // unreachable guard kept for clarity; real 2-decimal check below
  }
  const rounded = Math.round(n * 100) / 100;
  if (Math.abs(rounded - n) > 1e-9) {
    return { valid: false, error: 'Amount cannot have more than 2 decimal places' };
  }
  return { valid: true, value: rounded };
}

function isUuidLike(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// Translates known Postgres error codes into clean HTTP responses
// instead of letting every DB failure fall through as a 500.
function handleDbError(err, res, fallbackMessage) {
  console.error(err);
  if (err.code === '23503') {
    // foreign_key_violation - account id doesn't exist
    return res.status(404).json({ error: 'One or more account IDs do not exist' });
  }
  if (err.code === '23514') {
    // check_violation - e.g. amount <= 0 slipped through
    return res.status(400).json({ error: 'Invalid amount' });
  }
  if (err.code === '23505') {
    // unique_violation - idempotency key collided under a race
    return res.status(409).json({ error: 'Duplicate request (idempotency key already used)' });
  }
  return res.status(500).json({ error: fallbackMessage, detail: err.message });
}

function parsePagination(req, defaultLimit = 20, maxLimit = 100) {
  let limit = parseInt(req.query.limit, 10);
  let offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

// ============================================
// CORE TRANSFER LOGIC (shared by /transfer, /deposit, /withdraw, /benchmark)
// idempotency check, row lock, balance check (unless skipped), write
// entries, commit. Now also times its own execution so callers can
// report processing latency separately from network/HTTP overhead.
// ============================================
async function executeTransfer({ idempotency_key, from_account_id, to_account_id, amount, skipBalanceCheck = false }) {
  const start = process.hrtime.bigint();

  const existing = await pool.query(
    'SELECT * FROM transactions WHERE idempotency_key = $1',
    [idempotency_key]
  );
  if (existing.rows.length > 0) {
    return { alreadyProcessed: true, transaction: existing.rows[0], duration_ms: 0 };
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
        const duration_ms = Number(process.hrtime.bigint() - start) / 1e6;
        return { insufficientBalance: true, available: currentBalance, duration_ms };
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
    const duration_ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { transaction, duration_ms };
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
  try {
    const result = await pool.query(
      "SELECT * FROM account_balances WHERE owner_name != 'External' ORDER BY owner_name"
    );
    res.json(result.rows);
  } catch (err) {
    handleDbError(err, res, 'Could not load accounts');
  }
});

// ============================================
// POST /accounts
// Creates a new account with a starting balance of zero.
// Anyone using the live demo can create their own account this way,
// instead of needing manual database access.
// ============================================
app.post('/accounts', async (req, res) => {
  const { owner_name } = req.body;
  if (!owner_name || !owner_name.trim()) {
    return res.status(400).json({ error: 'Account name is required' });
  }
  if (owner_name.trim().length > 60) {
    return res.status(400).json({ error: 'Account name is too long (max 60 characters)' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO accounts (owner_name) VALUES ($1) RETURNING id AS account_id, owner_name',
      [owner_name.trim()]
    );
    res.status(201).json({ ...result.rows[0], balance: '0.00' });
  } catch (err) {
    handleDbError(err, res, 'Could not create account');
  }
});

// ============================================
// GET /transactions
// Lists recent transactions, with account names joined in
// (instead of just raw UUIDs). Supports ?limit=&offset= pagination -
// defaults to 20 like before, capped at 100 per page.
// ============================================
app.get('/transactions', async (req, res) => {
  const { limit, offset } = parsePagination(req);
  try {
    const result = await pool.query(
      `SELECT t.*, fa.owner_name AS from_name, ta.owner_name AS to_name
       FROM transactions t
       JOIN accounts fa ON fa.id = t.from_account_id
       JOIN accounts ta ON ta.id = t.to_account_id
       ORDER BY t.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM transactions');
    res.json({ data: result.rows, limit, offset, total: countResult.rows[0].total });
  } catch (err) {
    handleDbError(err, res, 'Could not load transactions');
  }
});

// ============================================
// GET /accounts/:id/history
// The ledger entries (debit/credit lines) for one specific account -
// used by the "Live Ledger Feed" panel. Also paginated now.
// ============================================
app.get('/accounts/:id/history', async (req, res) => {
  if (!isUuidLike(req.params.id)) {
    return res.status(400).json({ error: 'Invalid account id' });
  }
  const { limit, offset } = parsePagination(req);
  try {
    const result = await pool.query(
      `SELECT le.*, le.amount AS entry_amount
       FROM ledger_entries le
       WHERE le.account_id = $1
       ORDER BY le.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    handleDbError(err, res, 'Could not load account history');
  }
});

// ============================================
// POST /transfer
// Moves money from one account to another.
// ============================================
app.post('/transfer', async (req, res) => {
  const { idempotency_key, from_account_id, to_account_id, amount } = req.body;
  if (!idempotency_key || !from_account_id || !to_account_id) {
    return res.status(400).json({ error: 'Missing required field' });
  }
  if (from_account_id === to_account_id) {
    return res.status(400).json({ error: 'Sender and receiver cannot be the same account' });
  }
  const amountCheck = validateAmount(amount);
  if (!amountCheck.valid) {
    return res.status(400).json({ error: amountCheck.error });
  }
  try {
    const result = await executeTransfer({
      idempotency_key,
      from_account_id,
      to_account_id,
      amount: amountCheck.value,
    });
    if (result.alreadyProcessed) {
      return res.status(200).json({ message: 'Already processed (idempotent replay)', transaction: result.transaction });
    }
    if (result.insufficientBalance) {
      return res.status(400).json({ error: 'Insufficient balance', available: result.available });
    }
    res.status(201).json({
      message: 'Transfer successful',
      transaction: result.transaction,
      duration_ms: Math.round(result.duration_ms * 100) / 100,
    });
  } catch (err) {
    handleDbError(err, res, 'Transfer failed');
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
  if (!idempotency_key || !account_id) {
    return res.status(400).json({ error: 'Missing required field' });
  }
  const amountCheck = validateAmount(amount);
  if (!amountCheck.valid) {
    return res.status(400).json({ error: amountCheck.error });
  }
  try {
    const result = await executeTransfer({
      idempotency_key,
      from_account_id: externalAccountId,
      to_account_id: account_id,
      amount: amountCheck.value,
      skipBalanceCheck: true,
    });
    if (result.alreadyProcessed) {
      return res.status(200).json({ message: 'Already processed (idempotent replay)', transaction: result.transaction });
    }
    res.status(201).json({
      message: 'Deposit successful',
      transaction: result.transaction,
      duration_ms: Math.round(result.duration_ms * 100) / 100,
    });
  } catch (err) {
    handleDbError(err, res, 'Deposit failed');
  }
});

// ============================================
// POST /withdraw
// Removes money from an account, TO the External account.
// This one DOES check balance - a real account can't go negative.
// ============================================
app.post('/withdraw', async (req, res) => {
  const { idempotency_key, account_id, amount } = req.body;
  if (!idempotency_key || !account_id) {
    return res.status(400).json({ error: 'Missing required field' });
  }
  const amountCheck = validateAmount(amount);
  if (!amountCheck.valid) {
    return res.status(400).json({ error: amountCheck.error });
  }
  try {
    const result = await executeTransfer({
      idempotency_key,
      from_account_id: account_id,
      to_account_id: externalAccountId,
      amount: amountCheck.value,
    });
    if (result.alreadyProcessed) {
      return res.status(200).json({ message: 'Already processed (idempotent replay)', transaction: result.transaction });
    }
    if (result.insufficientBalance) {
      return res.status(400).json({ error: 'Insufficient balance', available: result.available });
    }
    res.status(201).json({
      message: 'Withdrawal successful',
      transaction: result.transaction,
      duration_ms: Math.round(result.duration_ms * 100) / 100,
    });
  } catch (err) {
    handleDbError(err, res, 'Withdrawal failed');
  }
});

// Quick helper endpoint so we can actually see balances while testing
app.get('/accounts/:id/balance', async (req, res) => {
  if (!isUuidLike(req.params.id)) {
    return res.status(400).json({ error: 'Invalid account id' });
  }
  try {
    const result = await pool.query(
      'SELECT * FROM account_balances WHERE account_id = $1',
      [req.params.id]
    );
    res.json(result.rows[0] || { balance: 0 });
  } catch (err) {
    handleDbError(err, res, 'Could not load balance');
  }
});

// ============================================
// POST /benchmark
// Fires N concurrent transfers directly against executeTransfer -
// no HTTP round-trip per request - so the reported throughput
// reflects DB lock contention + write speed, not browser/network
// latency. This is the number worth quoting as your system's tx/sec.
// ============================================
app.post('/benchmark', async (req, res) => {
  const { from_account_id, to_account_id, requests = 50 } = req.body;
  if (!isUuidLike(from_account_id) || !isUuidLike(to_account_id)) {
    return res.status(400).json({ error: 'Valid from_account_id and to_account_id are required' });
  }
  if (from_account_id === to_account_id) {
    return res.status(400).json({ error: 'Sender and receiver cannot be the same account' });
  }
  const n = Math.min(Math.max(parseInt(requests, 10) || 50, 1), 500);

  const latencies = [];
  let succeeded = 0;
  let failed = 0;

  const runOne = async (i) => {
    const start = process.hrtime.bigint();
    try {
      const result = await executeTransfer({
        idempotency_key: `bench-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
        from_account_id,
        to_account_id,
        amount: 1,
      });
      latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
      if (result.insufficientBalance) failed++;
      else succeeded++;
    } catch (err) {
      latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
      failed++;
    }
  };

  const wallStart = process.hrtime.bigint();
  await Promise.all(Array.from({ length: n }, (_, i) => runOne(i)));
  const totalMs = Number(process.hrtime.bigint() - wallStart) / 1e6;

  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)];
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const round2 = (x) => Math.round(x * 100) / 100;

  res.json({
    total_requests: n,
    succeeded,
    failed,
    total_time_ms: Math.round(totalMs),
    requests_per_sec: round2((n / totalMs) * 1000),
    avg_latency_ms: round2(avg),
    p50_latency_ms: round2(pct(50)),
    p95_latency_ms: round2(pct(95)),
    p99_latency_ms: round2(pct(99)),
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// POST /reset
// Wipes every ledger entry, transaction, and account, then reseeds
// three demo accounts with starting balances - so the live demo can
// always be put back to a clean starting state without needing
// database access. Rate limited separately since it's destructive.
// ============================================
const resetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Reset can only be called a few times per minute.' },
});

app.post('/reset', resetLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE ledger_entries, transactions, accounts');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return handleDbError(err, res, 'Reset failed');
  } finally {
    client.release();
  }

  try {
    await ensureExternalAccount();

    const seedAccounts = [
      { owner_name: 'Alice', opening_balance: 5000 },
      { owner_name: 'Bob', opening_balance: 3000 },
      { owner_name: 'Charlie', opening_balance: 1000 },
    ];

    const created = [];
    for (const seed of seedAccounts) {
      const accResult = await pool.query(
        'INSERT INTO accounts (owner_name) VALUES ($1) RETURNING id',
        [seed.owner_name]
      );
      const accountId = accResult.rows[0].id;
      await executeTransfer({
        idempotency_key: `seed-${accountId}`,
        from_account_id: externalAccountId,
        to_account_id: accountId,
        amount: seed.opening_balance,
        skipBalanceCheck: true,
      });
      created.push({ owner_name: seed.owner_name, account_id: accountId, opening_balance: seed.opening_balance });
    }

    res.json({ message: 'Demo reset to starting state', accounts: created });
  } catch (err) {
    handleDbError(err, res, 'Reset succeeded but reseeding failed');
  }
});

const PORT = process.env.PORT || 3000;

// Only start listening when this file is run directly (`node index.js`).
// When it's `require()`d by the test suite, we just export `app` and let
// the tests manage the DB connection/lifecycle themselves.
if (require.main === module) {
  ensureExternalAccount().then(() => {
    app.listen(PORT, () => console.log(`Ledger server running on port ${PORT}`));
  });
}

module.exports = { app, pool, executeTransfer, ensureExternalAccount, validateAmount };
