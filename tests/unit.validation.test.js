const test = require('node:test');
const assert = require('node:assert/strict');
const { schemas } = require('../src/validation');

test('task validation rejects unsupported statuses and invalid dates', () => {
  const result = schemas.task.safeParse({ title: 'Test', status: 'done', dueDate: 'tomorrow' });
  assert.equal(result.success, false);
});

test('invitation validation applies a bounded default expiry', () => {
  const result = schemas.invitation.parse({ userId: 2 });
  assert.equal(result.expiresInDays, 7);
  assert.throws(() => schemas.invitation.parse({ userId: 2, expiresInDays: 31 }));
});
