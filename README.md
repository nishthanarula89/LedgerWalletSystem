# Ledger & Wallet System (TransactOS)

A backend-first ledger and wallet system demonstrating double-entry accounting, ACID transactions, row-level locking, and idempotent request handling — the core correctness problems behind any real payment infrastructure.

**Live Demo:** https://ledgerwalletsystem.onrender.com
*(hosted on Render's free tier — first load may take ~30-50s to wake up)*

**Stack:** Node.js, Express, PostgreSQL, vanilla JS frontend

---

## Why this project exists

Most student backend projects are CRUD apps with a `balance` field that gets overwritten on every transaction. That approach breaks under two conditions that come up immediately in any real payment system:

1. **Concurrent requests** — two simultaneous transfers from the same account can both read the same "before" balance and approve, causing an overdraft that shouldn't be possible.
2. **Retries** — a client retrying a failed request (bad network, double-click) can cause the same payment to be processed twice.

This system is built to survive both, and includes a load test proving it.

## Core design decisions

**No stored balance.** Balance is never written directly — it's always calculated on read, by summing `ledger_entries` for an account (`credit - debit`). This means the balance can never silently drift out of sync with what actually happened.

**Double-entry accounting.** Every transaction writes exactly two ledger entries: a debit on one account, a credit on another. Deposits and withdrawals are modeled as transfers to/from a special `External` account (representing money entering/leaving the system from outside), rather than as privileged "create money" operations — this keeps the accounting invariant (`sum of all entries == 0`) true everywhere, no exceptions.

**Idempotency keys.** Every write operation requires a unique `idempotency_key`. It's enforced with a `UNIQUE` database constraint, so duplicate requests are rejected by Postgres itself — no custom deduplication logic to get wrong.

**Row-level locking.** Before checking a sender's balance, the system runs `SELECT ... FOR UPDATE` on that account row, forcing concurrent requests against the same account to queue instead of racing. This is what prevents overdrafts under simultaneous load.

## Proof, not just claims

A live "Concurrency Stress Test" button in the UI fires 20 simultaneous transfer requests from a single account and reports how many succeeded vs. were correctly rejected for insufficient balance — demonstrating the locking holds under real concurrent load, not just in theory.

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/accounts` | List all accounts with live-calculated balances |
| `POST` | `/accounts` | Create a new account |
| `GET` | `/accounts/:id/history` | Ledger entries (debit/credit) for one account |
| `GET` | `/transactions` | Recent transactions across all accounts |
| `POST` | `/transfer` | Transfer funds between two accounts |
| `POST` | `/deposit` | Add funds to an account (from the External account) |
| `POST` | `/withdraw` | Remove funds from an account (to the External account) |

All write endpoints (`/transfer`, `/deposit`, `/withdraw`) require an `idempotency_key` in the request body.

## Running it locally

**Prerequisites:** Node.js, PostgreSQL installed locally.

```bash
# 1. Install dependencies
npm install

# 2. Create the database and user
psql -U postgres -c "CREATE USER ledger_user WITH PASSWORD 'ledger_pass';"
psql -U postgres -c "CREATE DATABASE ledger_db OWNER ledger_user;"

# 3. Build the schema
psql -U ledger_user -d ledger_db -f schema.sql

# 4. Create a .env file in the project root
DB_USER=ledger_user
DB_PASSWORD=ledger_pass
DB_NAME=ledger_db
DB_HOST=localhost
DB_PORT=5432

# 5. Run the server
node index.js
```

Then open `http://localhost:3000`.

## Deployment

Deployed on Render as a single Web Service (Express serves both the API and the static frontend from `/public`). The database connects via a single `DATABASE_URL` environment variable (Render's internal Postgres connection string) rather than five separate host/user/password fields, reducing configuration surface area.

## What's next

- Throughput benchmarking (requests/sec under load, using a tool like `autocannon`)
- Additional test coverage for the transfer/deposit/withdraw logic
- Rate limiting and input validation hardening 
