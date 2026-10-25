const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { register, auth, db } = require('./helpers');

test('declined invitations and expired invitations cannot create memberships', async () => {
  const owner = await register('Invite Owner', `invite-owner-${Date.now()}@example.com`);
  const member = await register('Invite Member', `invite-member-${Date.now()}@example.com`);
  const team = await auth(owner.token).post('/api/teams').send({ name: 'Invite Team' });
  const declinedInvite = await auth(owner.token).post(`/api/teams/${team.body.team.id}/invitations`).send({ userId: member.user.id });
  const decline = await auth(member.token).post(`/api/invitations/team/${declinedInvite.body.invitation.id}/respond`).send({ action: 'decline' });
  assert.equal(decline.status, 200);
  const members = await auth(member.token).get(`/api/teams/${team.body.team.id}/members`);
  assert.equal(members.status, 403);
  const expiredInvite = await auth(owner.token).post(`/api/teams/${team.body.team.id}/invitations`).send({ userId: member.user.id, expiresInDays: 1 });
  db.prepare("UPDATE team_invitations SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(expiredInvite.body.invitation.id);
  const expiry = await auth(member.token).get('/api/invitations');
  assert.equal(expiry.body.invitations.some((invitation) => invitation.id === expiredInvite.body.invitation.id), true);
  const expiredResponse = await auth(member.token).post(`/api/invitations/team/${expiredInvite.body.invitation.id}/respond`).send({ action: 'accept' });
  assert.equal(expiredResponse.status, 409);
});

test('allowed attachment upload persists and can be deleted by its uploader', async () => {
  const user = await register('Attachment User', `attachment-${Date.now()}@example.com`);
  const task = await auth(user.token).post('/api/tasks').send({ title: 'Attachment task' });
  const uploaded = await auth(user.token).attach(`/api/tasks/${task.body.task.id}/attachments`, 'file', Buffer.from('hello'), 'note.txt');
  assert.equal(uploaded.status, 201);
  const deleted = await auth(user.token).delete(`/api/tasks/${task.body.task.id}/attachments/${uploaded.body.attachment.id}`);
  assert.equal(deleted.status, 204);
});

test('spoofed and oversized attachments are rejected without metadata', async () => {
  const user = await register('File Security User', `file-security-${Date.now()}@example.com`);
  const task = await auth(user.token).post('/api/tasks').send({ title: 'File validation task' });
  const uploadDir = process.env.UPLOAD_DIR;
  const spoofed = await auth(user.token).attach(`/api/tasks/${task.body.task.id}/attachments`, 'file', Buffer.from('not a png'), { filename: 'fake.png', contentType: 'image/png' });
  assert.equal(spoofed.status, 400);
  assert.equal(fs.readdirSync(uploadDir).length, 0);
  const oversized = await auth(user.token).attach(`/api/tasks/${task.body.task.id}/attachments`, 'file', Buffer.alloc(10 * 1024 * 1024 + 1, 65), { filename: 'large.txt', contentType: 'text/plain' });
  assert.equal(oversized.status, 400);
  assert.deepEqual(fs.readdirSync(uploadDir).filter((entry) => !entry.startsWith('.')), []);
  const attachments = await auth(user.token).get(`/api/tasks/${task.body.task.id}/attachments`);
  assert.equal(attachments.body.attachments.length, 0);
});
