const test = require('node:test');
const assert = require('node:assert/strict');
const { request, register, auth } = require('./helpers');

test('registration persists a user and login returns a usable session', async () => {
  const email = `auth-${Date.now()}@example.com`;
  const created = await register('Auth User', email);
  assert.equal(created.response.status, 201);
  const profile = await auth(created.token).get('/api/me');
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.email, email);
  const login = await request.post('/api/auth/login').send({ email, password: 'Password123!' });
  assert.equal(login.status, 200);
  const unauthorized = await request.get('/api/me');
  assert.equal(unauthorized.status, 401);
});
