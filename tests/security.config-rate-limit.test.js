const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-config-tests-123';
process.env.DATABASE_FILE = './data/config-test.db';
process.env.AUTH_RATE_LIMIT_MAX = '1';
const { validateJwtSecret } = require('../src/auth');
const server = require('../src/server');
const { createAuthRateLimiter } = server;

test('JWT configuration rejects placeholders in production', () => {
  assert.throws(() => validateJwtSecret('replace-this-with-a-long-random-secret', 'production'));
  assert.throws(() => validateJwtSecret('development-secret-that-is-long-enough', 'production'));
  assert.equal(validateJwtSecret('random-production-secret-that-is-long-enough-123', 'production'), 'random-production-secret-that-is-long-enough-123');
});

test('authentication rate limiter returns 429 after the configured limit', async () => {
  const app = express();
  app.use(createAuthRateLimiter({ windowMs: 60_000, limit: 2 }));
  app.post('/login', (_req, res) => res.json({ ok: true }));
  const client = supertest(app);
  assert.equal((await client.post('/login')).status, 200);
  assert.equal((await client.post('/login')).status, 200);
  const limited = await client.post('/login');
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /too many authentication attempts/i);
});

test('configured login endpoint rate limiter returns 429', async () => {
  const client = supertest(server);
  assert.equal((await client.post('/api/auth/login').send({ email: 'unknown@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await client.post('/api/auth/login').send({ email: 'unknown@example.com', password: 'wrong-password' })).status, 429);
});

test('configured registration endpoint rate limiter returns 429', async () => {
  const client = supertest(server);
  const first = await client.post('/api/auth/register').send({ name: 'Rate User', email: `rate-${Date.now()}@example.com`, password: 'Password123!' });
  assert.equal(first.status, 201);
  const second = await client.post('/api/auth/register').send({ name: 'Rate User 2', email: `rate-2-${Date.now()}@example.com`, password: 'Password123!' });
  assert.equal(second.status, 429);
});
