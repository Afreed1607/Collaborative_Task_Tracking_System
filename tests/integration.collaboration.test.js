const test = require('node:test');
const assert = require('node:assert/strict');
const { register, auth } = require('./helpers');

test('project invitation acceptance enables project task collaboration', async () => {
  const owner = await register('Project Owner', `owner-${Date.now()}@example.com`);
  const member = await register('Project Member', `member-${Date.now()}@example.com`);
  const projectResponse = await auth(owner.token).post('/api/projects').send({ name: 'Launch Project', description: 'Release work' });
  assert.equal(projectResponse.status, 201);
  const inviteResponse = await auth(owner.token).post(`/api/projects/${projectResponse.body.project.id}/invitations`).send({ userId: member.user.id });
  assert.equal(inviteResponse.status, 201);
  const invitations = await auth(member.token).get('/api/invitations');
  assert.equal(invitations.body.invitations.length, 1);
  const invitation = invitations.body.invitations[0];
  const accepted = await auth(member.token).post(`/api/invitations/project/${invitation.id}/respond`).send({ action: 'accept' });
  assert.equal(accepted.status, 200);
  const task = await auth(owner.token).post('/api/tasks').send({ title: 'Project task', projectId: projectResponse.body.project.id, assigneeId: member.user.id });
  assert.equal(task.status, 201);
  const memberTasks = await auth(member.token).get('/api/tasks/assigned-to-me');
  assert.equal(memberTasks.body.tasks[0].title, 'Project task');
});
