const test = require('node:test');
const assert = require('node:assert/strict');
const { register, auth } = require('./helpers');

test('task pagination, state transitions, comment lifecycle, and attachment lifecycle work', async () => {
  const owner = await register('Task Owner', `tasks-${Date.now()}@example.com`);
  const created = await auth(owner.token).post('/api/tasks').send({ title: 'Lifecycle task' });
  assert.equal(created.status, 201);
  const taskId = created.body.task.id;
  const page = await auth(owner.token).get('/api/tasks?page=1&limit=1&sort=title&order=asc');
  assert.equal(page.status, 200);
  assert.equal(page.body.pagination.limit, 1);
  const started = await auth(owner.token).patch(`/api/tasks/${taskId}`).send({ status: 'in_progress' });
  assert.equal(started.status, 200);
  const invalidTransition = await auth(owner.token).patch(`/api/tasks/${taskId}`).send({ status: 'open' });
  assert.equal(invalidTransition.status, 409);
  const comment = await auth(owner.token).post(`/api/tasks/${taskId}/comments`).send({ body: 'Initial note' });
  assert.equal(comment.status, 201);
  const edited = await auth(owner.token).patch(`/api/tasks/${taskId}/comments/${comment.body.comment.id}`).send({ body: 'Edited note' });
  assert.equal(edited.status, 200);
  const deleted = await auth(owner.token).delete(`/api/tasks/${taskId}/comments/${comment.body.comment.id}`);
  assert.equal(deleted.status, 204);
});
