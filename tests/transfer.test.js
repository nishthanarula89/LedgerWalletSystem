// ============================================
// Integration tests against a real PostgreSQL database.
//
// These tests don't mock the DB - they run the actual schema.sql
// through the actual connection pool, because the entire point of
// this project is proving row-level locking and idempotency hold
// under real concurrent load. Mocking the DB would test nothing.
//
// Requires: a Postgres instance reachable via the same env vars
// index.js/db.js use (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT,
// or DATABASE_URL), with schema.sql already applied. Run:
//   npm test
// ============================================

const request = require('supertest');
const { app, pool, ensureExternalAccount } = require('../index');

async function createAccount(ownerName) {
  const res = await request(app).post('/accounts').send({ owner_name: ownerName });
  expect(res.status).toBe(201);
  return res.body.account_id;
}

async function deposit(accountId, amount) {
  const res = await request(app).post('/deposit').send({
    idempotency_key: `test-deposit-${accountId}-${Math.random()}`,
    account_id: accountId,
    amount,
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function getBalance(accountId) {
  const res = await request(app).get(`/accounts/${accountId}/balance`);
  return Number(res.body.balance);
}

beforeAll(async () => {
  await ensureExternalAccount();
});

afterAll(async () => {
  await pool.end();
});

describe('Idempotency', () => {
  test('replaying the same idempotency_key does not double-process a transfer', async () => {
    const alice = await createAccount(`Alice-${Date.now()}`);
    const bob = await createAccount(`Bob-${Date.now()}`);
    await deposit(alice, 100);

    const idempotency_key = `idem-test-${Date.now()}`;
    const payload = { idempotency_key, from_account_id: alice, to_account_id: bob, amount: 30 };

    const first = await request(app).post('/transfer').send(payload);
    expect(first.status).toBe(201);
    expect(first.body.message).toBe('Transfer successful');

    // Same key, same request, sent again - as if a client retried after a timeout.
    const second = await request(app).post('/transfer').send(payload);
    expect(second.status).toBe(200);
    expect(second.body.message).toContain('Already processed');

    // Money should only have moved once.
    expect(await getBalance(alice)).toBe(70);
    expect(await getBalance(bob)).toBe(30);
  });

  test('different idempotency_keys with identical bodies are treated as separate transfers', async () => {
    const alice = await createAccount(`Alice-${Date.now()}`);
    const bob = await createAccount(`Bob-${Date.now()}`);
    await deposit(alice, 100);

    const payload = { from_account_id: alice, to_account_id: bob, amount: 10 };
    await request(app).post('/transfer').send({ ...payload, idempotency_key: `k1-${Date.now()}` });
    await request(app).post('/transfer').send({ ...payload, idempotency_key: `k2-${Date.now()}` });

    expect(await getBalance(alice)).toBe(80);
    expect(await getBalance(bob)).toBe(20);
  });
});

describe('Concurrency / overdraft protection', () => {
  test('20 concurrent transfers of 1 from a balance of 15 result in exactly 15 successes', async () => {
    const sender = await createAccount(`Sender-${Date.now()}`);
    const receiver = await createAccount(`Receiver-${Date.now()}`);
    await deposit(sender, 15);

    const requests = Array.from({ length: 20 }, (_, i) =>
      request(app).post('/transfer').send({
        idempotency_key: `concurrent-${Date.now()}-${i}`,
        from_account_id: sender,
        to_account_id: receiver,
        amount: 1,
      })
    );

    const results = await Promise.all(requests);
    const succeeded = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 400 && r.body.error === 'Insufficient balance').length;

    expect(succeeded).toBe(15);
    expect(rejected).toBe(5);
    expect(await getBalance(sender)).toBe(0);
    expect(await getBalance(receiver)).toBe(15);
  });
});

describe('Input validation', () => {
  let alice;
  let bob;

  beforeAll(async () => {
    alice = await createAccount(`Alice-${Date.now()}`);
    bob = await createAccount(`Bob-${Date.now()}`);
    await deposit(alice, 500);
  });

  test('rejects a negative amount with 400, not a raw DB error', async () => {
    const res = await request(app).post('/transfer').send({
      idempotency_key: `neg-${Date.now()}`,
      from_account_id: alice,
      to_account_id: bob,
      amount: -50,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/greater than 0/);
  });

  test('rejects zero amount', async () => {
    const res = await request(app).post('/transfer').send({
      idempotency_key: `zero-${Date.now()}`,
      from_account_id: alice,
      to_account_id: bob,
      amount: 0,
    });
    expect(res.status).toBe(400);
  });

  test('rejects more than 2 decimal places', async () => {
    const res = await request(app).post('/transfer').send({
      idempotency_key: `decimals-${Date.now()}`,
      from_account_id: alice,
      to_account_id: bob,
      amount: 10.999,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/decimal/);
  });

  test('rejects sender and receiver being the same account', async () => {
    const res = await request(app).post('/transfer').send({
      idempotency_key: `same-${Date.now()}`,
      from_account_id: alice,
      to_account_id: alice,
      amount: 10,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same account/);
  });

  test('rejects a transfer to a non-existent account with 404, not 500', async () => {
    const res = await request(app).post('/transfer').send({
      idempotency_key: `ghost-${Date.now()}`,
      from_account_id: alice,
      to_account_id: '00000000-0000-0000-0000-000000000000',
      amount: 10,
    });
    expect(res.status).toBe(404);
  });

  test('rejects missing required fields', async () => {
    const res = await request(app).post('/transfer').send({ from_account_id: alice });
    expect(res.status).toBe(400);
  });
});

describe('Benchmark endpoint', () => {
  test('reports throughput stats for N concurrent transfers', async () => {
    const sender = await createAccount(`BenchSender-${Date.now()}`);
    const receiver = await createAccount(`BenchReceiver-${Date.now()}`);
    await deposit(sender, 1000);

    const res = await request(app).post('/benchmark').send({
      from_account_id: sender,
      to_account_id: receiver,
      requests: 25,
    });

    expect(res.status).toBe(200);
    expect(res.body.total_requests).toBe(25);
    expect(res.body.succeeded).toBe(25);
    expect(res.body.requests_per_sec).toBeGreaterThan(0);
    expect(res.body.avg_latency_ms).toBeGreaterThan(0);
  });
});
