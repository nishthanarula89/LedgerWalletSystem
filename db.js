// This file's only job: create ONE connection pool to Postgres
// that the rest of the app reuses. A "pool" = a small stack of
// ready-to-use connections, so we're not opening a brand new
// connection on every single request (that would be slow).

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

module.exports = pool;