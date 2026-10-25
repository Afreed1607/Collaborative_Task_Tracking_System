const test = require('node:test');
const assert = require('node:assert/strict');
const { request, register, auth } = require('./helpers');

test('invalid tokens and disallowed origins are rejected', async () => {
  const invalid = await request.get('/api/me').set('Authorization', 'Bearer invalid-token');
  assert.equal(invalid.status, 401);
  const cors = await request.get('/health').set('Origin', 'https://untrusted.example');
  assert.equal(cors.status, 403);
  const user = await register('Security User', `security-${Date.now()}@example.com`);
  const profile = await auth(user.token).get('/api/me');
  assert.equal(profile.headers['x-content-type-options'], 'nosniff');
});
