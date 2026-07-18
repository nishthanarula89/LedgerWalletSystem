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

This system is built to survive both, and includes a load test — and an automated test suite — proving it.

## Core design decisions

**No stored balance.** Balance is never written directly — it's always calculated on read, by summing `ledger_entries` for an account (`credit - debit`). This means the balance can never silently drift out of sync with what actually happened.

**Double-entry accounting.** Every transaction writes exactly two ledger entries: a debit on one account, a credit on another. Deposits and withdrawals are modeled as transfers to/from a special `External` account (representing money entering/leaving the system from outside), rather than as privileged "create money" operations — this keeps the accounting invariant (`sum of all entries == 0`) true everywhere, no exceptions.

**Idempotency keys.** Every write operation requires a unique `idempotency_key`. It's enforced with a `UNIQUE` database constraint, so duplicate requests are rejected by Postgres itself — no custom deduplication logic to get wrong.

**Row-level locking.** Before checking a sender's balance, the system runs `SELECT ... FOR UPDATE` on that account row, forcing concurrent requests against the same account to queue instead of racing. This is what prevents overdrafts under simultaneous load.

**Input validation before the DB layer.** Amounts are validated (positive, finite, ≤2 decimal places, sane upper bound) and account IDs are checked before touching Postgres, so bad input returns a clean `400`/`404` instead of a raw `500` from a tripped constraint.

## Scope decisions (deliberate, not oversights)

- **No authentication.** Any caller can transfer between any two account IDs. This is intentional for a public, resettable demo — a production version would add auth + authorization on top of this same ledger core.
- **Rate limits are demo-tuned, not production-tuned.** General routes allow 300 requests/min per IP so the in-UI stress test and benchmark aren't rate-limited into uselessness. `/reset` is capped tighter (5/min) since it's destructive.
- **Amounts are stored as `NUMERIC(14,2)`**, validated at the API boundary to reject anything with more than 2 decimal places. A production system handling real currency would represent amounts as integer minor units (paise/cents) end-to-end to avoid floating-point ambiguity entirely.

## Proof, not just claims

- A **Concurrency Stress Test** panel fires 20 simultaneous transfer requests from one account and shows a live console with the timestamp and latency of each request, reporting how many succeeded vs. were correctly rejected for insufficient balance.
- A **Throughput Benchmark** panel fires 20–500 transfers concurrently *at the database layer directly* (no per-request HTTP round-trip), reporting real tx/sec and p50/p95/p99 latency under lock contention — the number that actually reflects system throughput, not browser network conditions.
- An automated **Jest + Supertest suite** (`npm test`) asserts the same guarantees in CI-style form: e.g. 20 concurrent transfers of ₹1 against a ₹15 balance produce exactly 15 successes and 5 clean rejections, and a replayed idempotency key never double-processes a transfer.
- A **Reset Demo** button wipes all accounts/transactions/ledger entries and reseeds three demo accounts, so anyone using the live demo can put it back to a clean state without database access.

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/accounts` | List all accounts with live-calculated balances |
| `POST` | `/accounts` | Create a new account |
| `GET` | `/accounts/:id/history` | Ledger entries for one account (`?limit=&offset=`, default 20, max 100) |
| `GET` | `/accounts/:id/balance` | Live-calculated balance for one account |
| `GET` | `/transactions` | Recent transactions across all accounts (`?limit=&offset=`) |
| `POST` | `/transfer` | Transfer funds between two accounts |
| `POST` | `/deposit` | Add funds to an account (from the External account) |
| `POST` | `/withdraw` | Remove funds from an account (to the External account) |
| `POST` | `/benchmark` | Run N concurrent transfers server-side; returns tx/sec + latency percentiles |
| `POST` | `/reset` | Wipe all data and reseed 3 demo accounts (rate limited to 5/min) |

All write endpoints (`/transfer`, `/deposit`, `/withdraw`) require an `idempotency_key` in the request body, validate `amount` server-side, and return a `duration_ms` field showing DB-side processing time for that request.

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
npm start
```

Then open `http://localhost:3000`.

## Running the tests

```bash
npm test
```

Runs against the same Postgres database configured via your `.env` (or `DATABASE_URL`) — with `schema.sql` already applied. Tests create their own uniquely-named accounts per run, so they're safe to run against a live/demo database repeatedly.

## Deployment

Deployed on Render as a single Web Service (Express serves both the API and the static frontend from `/public`). The database connects via a single `DATABASE_URL` environment variable (Render's internal Postgres connection string) rather than five separate host/user/password fields, reducing configuration surface area.

## What's next

- Authentication + per-user authorization on top of the existing ledger core
- Integer minor-unit (paise) representation for amounts, end-to-end
- A `pending`/`failed` transaction status lifecycle instead of everything landing as `completed`
- Cursor-based pagination for very large transaction histories
