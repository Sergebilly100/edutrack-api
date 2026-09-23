import 'dotenv/config';

// Runs before test modules: a static db import must never select the dev DB.
if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST must point to a disposable integration database.');
}
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
