const express = require('express');
const pool = require('./db');

const app = express();
app.use(express.json());

app.post('/transfer', async (req, res) => {
  const { idempotency_key, from_account_id, to_account_id, amount } = req.body;

  if (!idempotency_key || !from_account_id || !to_account_id || !amount) {
    return res.status(400).json({ error: 'Missing required field' });
  }

  const existing = await pool.query(
    'SELECT * FROM transactions WHERE idempotency_key = $1',
    [idempotency_key]
  );
  if (existing.rows.length > 0) {
    return res.status(200).json({
      message: 'Already processed (idempotent replay)',
      transaction: existing.rows[0],
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      'SELECT * FROM accounts WHERE id = $1 FOR UPDATE',
      [from_account_id]
    );

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
      return res.status(400).json({
        error: 'Insufficient balance',
        available: currentBalance,
      });
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

    res.status(201).json({ message: 'Transfer successful', transaction });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Transfer failed', detail: err.message });
  } finally {
    client.release();
  }
});

app.get('/accounts/:id/balance', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM account_balances WHERE account_id = $1',
    [req.params.id]
  );
  res.json(result.rows[0] || { balance: 0 });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Ledger server running on port ${PORT}`));