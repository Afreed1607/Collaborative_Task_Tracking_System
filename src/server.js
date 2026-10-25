require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const swaggerUi = require('swagger-ui-express');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { authenticate, createToken } = require('./auth');
const { id, schemas, validate } = require('./validation');

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map((origin) => origin.trim()).filter(Boolean);
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGINS) throw new Error('CORS_ORIGINS must be configured in production');
fs.mkdirSync(uploadDir, { recursive: true });

const allowedMimeTypes = new Map([
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/png', ['.png']],
  ['image/gif', ['.gif']],
  ['application/pdf', ['.pdf']],
  ['text/plain', ['.txt']],
  ['text/csv', ['.csv']]
]);
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extensions = allowedMimeTypes.get(file.mimetype);
    callback(null, Boolean(extensions && extensions.includes(path.extname(file.originalname).toLowerCase())));
  }
});
const rateLimitWindowMs = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const rateLimitMax = Number(process.env.AUTH_RATE_LIMIT_MAX || 10);
function createAuthRateLimiter(options = {}) {
  return rateLimit({
    windowMs: options.windowMs || (Number.isInteger(rateLimitWindowMs) && rateLimitWindowMs > 0 ? rateLimitWindowMs : 15 * 60 * 1000),
    limit: options.limit || (Number.isInteger(rateLimitMax) && rateLimitMax > 0 ? rateLimitMax : 10),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts; try again later' }
  });
}
function hasValidFileSignature(file) {
  const content = fs.readFileSync(file.path);
  if (file.mimetype === 'image/jpeg') return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (file.mimetype === 'image/png') return content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (file.mimetype === 'image/gif') return content.subarray(0, 6).toString('ascii') === 'GIF87a' || content.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (file.mimetype === 'application/pdf') return content.subarray(0, 5).toString('ascii') === '%PDF-';
  if (file.mimetype === 'text/plain' || file.mimetype === 'text/csv') {
    return !content.includes(0) && !content.toString('utf8').includes('\ufffd');
  }
  return false;
}
function trackUploadFiles(req, _res, next) {
  req.uploadFilesBefore = new Set(fs.readdirSync(uploadDir));
  next();
}
function cleanupNewUploadFiles(req) {
  if (!req.uploadFilesBefore) return;
  for (const name of fs.readdirSync(uploadDir)) {
    if (!req.uploadFilesBefore.has(name)) fs.rmSync(path.join(uploadDir, name), { force: true });
  }
}
const registrationLimiter = createAuthRateLimiter();
const loginLimiter = createAuthRateLimiter();

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '1mb' }));

const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, avatarUrl: user.avatar_url, createdAt: user.created_at, updatedAt: user.updated_at });
const taskView = `
  SELECT t.*, u.name AS assignee_name, u.email AS assignee_email, c.name AS creator_name,
    tm.name AS team_name, p.name AS project_name
  FROM tasks t
  LEFT JOIN users u ON u.id = t.assignee_id
  LEFT JOIN users c ON c.id = t.creator_id
  LEFT JOIN teams tm ON tm.id = t.team_id
  LEFT JOIN projects p ON p.id = t.project_id
`;
const taskSorts = { dueDate: 't.due_date', createdAt: 't.created_at', updatedAt: 't.updated_at', title: 't.title', priority: 't.priority', status: 't.status' };
const transitions = { open: ['in_progress'], in_progress: ['completed'], completed: [] };

function formatTask(task) {
  return {
    id: task.id, title: task.title, description: task.description, dueDate: task.due_date, status: task.status, priority: task.priority,
    teamId: task.team_id, projectId: task.project_id, assigneeId: task.assignee_id, creatorId: task.creator_id,
    assignee: task.assignee_id ? { id: task.assignee_id, name: task.assignee_name, email: task.assignee_email } : null,
    creator: { id: task.creator_id, name: task.creator_name },
    team: task.team_id ? { id: task.team_id, name: task.team_name } : null,
    project: task.project_id ? { id: task.project_id, name: task.project_name } : null,
    createdAt: task.created_at, updatedAt: task.updated_at, completedAt: task.completed_at
  };
}
function getTask(taskId) { return db.prepare(`${taskView} WHERE t.id = ?`).get(taskId); }
function isTeamMember(teamId, userId) { return Boolean(db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId)); }
function isProjectMember(projectId, userId) { return Boolean(db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId)); }
function isTeamOwner(teamId, userId) { return Boolean(db.prepare('SELECT 1 FROM teams WHERE id = ? AND owner_id = ?').get(teamId, userId)); }
function isProjectOwner(projectId, userId) { return Boolean(db.prepare('SELECT 1 FROM projects WHERE id = ? AND owner_id = ?').get(projectId, userId)); }
function canAccessTask(task, userId) { return task && (task.creator_id === userId || task.assignee_id === userId || (task.team_id && isTeamMember(task.team_id, userId)) || (task.project_id && isProjectMember(task.project_id, userId))); }
function canManageTask(task, userId) { return task.creator_id === userId || (task.team_id && isTeamOwner(task.team_id, userId)) || (task.project_id && isProjectOwner(task.project_id, userId)); }
function requireTaskAccess(req, res, next) {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!canAccessTask(task, req.user.id)) return res.status(403).json({ error: 'You do not have access to this task' });
  req.task = task;
  next();
}
function getPage(query) {
  const page = Number(query.page || 1);
  const limit = Number(query.limit || 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  return { page, limit, offset: (page - 1) * limit };
}
function invitationStatus(table, invitation) {
  if (invitation.status === 'pending' && new Date(invitation.expires_at) <= new Date()) {
    db.prepare(`UPDATE ${table} SET status = 'expired' WHERE id = ?`).run(invitation.id);
    return 'expired';
  }
  return invitation.status;
}
function addMembership(table, idColumn, entityId, userId) {
  db.prepare(`INSERT OR IGNORE INTO ${table} (${idColumn}, user_id, role) VALUES (?, ?, 'member')`).run(entityId, userId);
}
function makeInvitation(table, entityColumn, entityId, inviterId, inviteeId, days) {
  const existing = db.prepare(`SELECT * FROM ${table} WHERE ${entityColumn} = ? AND invitee_id = ? AND status = 'pending'`).get(entityId, inviteeId);
  if (existing && invitationStatus(table, existing) === 'pending') return null;
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  const result = db.prepare(`INSERT INTO ${table} (${entityColumn}, inviter_id, invitee_id, expires_at) VALUES (?, ?, ?, ?)`).run(entityId, inviterId, inviteeId, expiresAt);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(result.lastInsertRowid);
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/openapi.json', (_req, res) => res.json(require('../openapi.json')));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(require('../openapi.json')));

app.post('/api/auth/register', registrationLimiter, validate(schemas.register), (req, res, next) => {
  try {
    const result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(req.body.name, req.body.email, bcrypt.hashSync(req.body.password, 12));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ user: publicUser(user), token: createToken(user.id) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Email is already registered' });
    next(error);
  }
});
app.post('/api/auth/login', loginLimiter, validate(schemas.login), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(req.body.email);
  if (!user || !bcrypt.compareSync(req.body.password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ user: publicUser(user), token: createToken(user.id) });
});
app.post('/api/auth/logout', authenticate, (req, res) => { db.prepare('UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.sessionId); res.status(204).send(); });
app.get('/api/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));
app.patch('/api/me', authenticate, validate(schemas.profile), (req, res) => {
  const fields = []; const values = [];
  if (req.body.name !== undefined) { fields.push('name = ?'); values.push(req.body.name); }
  if (req.body.avatarUrl !== undefined) { fields.push('avatar_url = ?'); values.push(req.body.avatarUrl); }
  db.prepare(`UPDATE users SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

app.use('/api', authenticate);

app.post('/api/teams', validate(schemas.team), (req, res) => {
  db.exec('BEGIN');
  try {
    const result = db.prepare('INSERT INTO teams (name, description, owner_id) VALUES (?, ?, ?)').run(req.body.name, req.body.description || null, req.user.id);
    db.prepare('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)').run(result.lastInsertRowid, req.user.id, 'owner');
    db.exec('COMMIT');
    res.status(201).json({ team: db.prepare('SELECT * FROM teams WHERE id = ?').get(result.lastInsertRowid) });
  } catch (error) { db.exec('ROLLBACK'); throw error; }
});
app.get('/api/teams', (req, res) => res.json({ teams: db.prepare(`SELECT t.*, tm.role FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? ORDER BY t.created_at DESC`).all(req.user.id) }));
app.patch('/api/teams/:teamId', validate(schemas.teamUpdate), (req, res) => {
  if (!isTeamOwner(req.params.teamId, req.user.id)) return res.status(403).json({ error: 'Only the team owner can update the team' });
  const fields = []; const values = [];
  if (req.body.name !== undefined) { fields.push('name = ?'); values.push(req.body.name); }
  if (req.body.description !== undefined) { fields.push('description = ?'); values.push(req.body.description); }
  db.prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id = ?`).run(...values, req.params.teamId);
  res.json({ team: db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId) });
});
app.delete('/api/teams/:teamId', (req, res) => {
  if (!isTeamOwner(req.params.teamId, req.user.id)) return res.status(403).json({ error: 'Only the team owner can delete the team' });
  db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.teamId);
  res.status(204).send();
});
app.get('/api/teams/:teamId/members', (req, res) => {
  if (!isTeamMember(req.params.teamId, req.user.id)) return res.status(403).json({ error: 'Team membership required' });
  res.json({ members: db.prepare(`SELECT u.id, u.name, u.email, tm.role, tm.joined_at FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ?`).all(req.params.teamId) });
});
app.post('/api/teams/:teamId/members', validate(schemas.member), (req, res) => {
  if (!isTeamOwner(req.params.teamId, req.user.id)) return res.status(403).json({ error: 'Only the team owner can add members' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(req.body.userId)) return res.status(404).json({ error: 'User not found' });
  if (isTeamMember(req.params.teamId, req.body.userId)) return res.status(409).json({ error: 'User is already a team member' });
  addMembership('team_members', 'team_id', req.params.teamId, req.body.userId);
  res.status(201).json({ message: 'Member added', deprecated: true });
});
app.delete('/api/teams/:teamId/members/:userId', (req, res) => {
  if (!isTeamOwner(req.params.teamId, req.user.id)) return res.status(403).json({ error: 'Only the team owner can remove members' });
  if (Number(req.params.userId) === req.user.id) return res.status(400).json({ error: 'The team owner cannot remove themselves' });
  const result = db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(req.params.teamId, req.params.userId);
  if (!result.changes) return res.status(404).json({ error: 'Team member not found' });
  res.status(204).send();
});
app.post('/api/teams/:teamId/invitations', validate(schemas.invitation), (req, res) => {
  if (!isTeamOwner(req.params.teamId, req.user.id)) return res.status(403).json({ error: 'Only the team owner can invite members' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(req.body.userId)) return res.status(404).json({ error: 'User not found' });
  if (isTeamMember(req.params.teamId, req.body.userId)) return res.status(409).json({ error: 'User is already a team member' });
  const invitation = makeInvitation('team_invitations', 'team_id', req.params.teamId, req.user.id, req.body.userId, req.body.expiresInDays);
  if (!invitation) return res.status(409).json({ error: 'A pending invitation already exists' });
  res.status(201).json({ invitation });
});

app.post('/api/projects', validate(schemas.project), (req, res) => {
  db.exec('BEGIN');
  try {
    const result = db.prepare('INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)').run(req.body.name, req.body.description || null, req.user.id);
    db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').run(result.lastInsertRowid, req.user.id, 'owner');
    db.exec('COMMIT');
    res.status(201).json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid) });
  } catch (error) { db.exec('ROLLBACK'); throw error; }
});
app.get('/api/projects', (req, res) => res.json({ projects: db.prepare(`SELECT p.*, pm.role FROM projects p JOIN project_members pm ON pm.project_id = p.id WHERE pm.user_id = ? ORDER BY p.created_at DESC`).all(req.user.id) }));
app.patch('/api/projects/:projectId', validate(schemas.projectUpdate), (req, res) => {
  if (!isProjectOwner(req.params.projectId, req.user.id)) return res.status(403).json({ error: 'Only the project owner can update the project' });
  const fields = []; const values = [];
  if (req.body.name !== undefined) { fields.push('name = ?'); values.push(req.body.name); }
  if (req.body.description !== undefined) { fields.push('description = ?'); values.push(req.body.description); }
  db.prepare(`UPDATE projects SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, req.params.projectId);
  res.json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId) });
});
app.delete('/api/projects/:projectId', (req, res) => {
  if (!isProjectOwner(req.params.projectId, req.user.id)) return res.status(403).json({ error: 'Only the project owner can delete the project' });
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.projectId);
  res.status(204).send();
});
app.get('/api/projects/:projectId/members', (req, res) => {
  if (!isProjectMember(req.params.projectId, req.user.id)) return res.status(403).json({ error: 'Project membership required' });
  res.json({ members: db.prepare(`SELECT u.id, u.name, u.email, pm.role, pm.joined_at FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ?`).all(req.params.projectId) });
});
app.delete('/api/projects/:projectId/members/:userId', (req, res) => {
  if (!isProjectOwner(req.params.projectId, req.user.id)) return res.status(403).json({ error: 'Only the project owner can remove members' });
  if (Number(req.params.userId) === req.user.id) return res.status(400).json({ error: 'The project owner cannot remove themselves' });
  const result = db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(req.params.projectId, req.params.userId);
  if (!result.changes) return res.status(404).json({ error: 'Project member not found' });
  res.status(204).send();
});
app.post('/api/projects/:projectId/invitations', validate(schemas.invitation), (req, res) => {
  if (!isProjectOwner(req.params.projectId, req.user.id)) return res.status(403).json({ error: 'Only the project owner can invite members' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(req.body.userId)) return res.status(404).json({ error: 'User not found' });
  if (isProjectMember(req.params.projectId, req.body.userId)) return res.status(409).json({ error: 'User is already a project member' });
  const invitation = makeInvitation('project_invitations', 'project_id', req.params.projectId, req.user.id, req.body.userId, req.body.expiresInDays);
  if (!invitation) return res.status(409).json({ error: 'A pending invitation already exists' });
  res.status(201).json({ invitation });
});
app.get('/api/invitations', (req, res) => {
  const teams = db.prepare(`SELECT i.*, t.name AS team_name FROM team_invitations i JOIN teams t ON t.id = i.team_id WHERE i.invitee_id = ?`).all(req.user.id).map((item) => ({ ...item, status: invitationStatus('team_invitations', item), type: 'team' }));
  const projects = db.prepare(`SELECT i.*, p.name AS project_name FROM project_invitations i JOIN projects p ON p.id = i.project_id WHERE i.invitee_id = ?`).all(req.user.id).map((item) => ({ ...item, status: invitationStatus('project_invitations', item), type: 'project' }));
  res.json({ invitations: [...teams, ...projects].sort((a, b) => b.created_at.localeCompare(a.created_at)) });
});
app.post('/api/invitations/:type/:invitationId/respond', validate(schemas.invitationResponse), (req, res) => {
  const isTeam = req.params.type === 'team';
  if (!isTeam && req.params.type !== 'project') return res.status(400).json({ error: 'Invitation type must be team or project' });
  const table = isTeam ? 'team_invitations' : 'project_invitations';
  const entityColumn = isTeam ? 'team_id' : 'project_id';
  const invitation = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND invitee_id = ?`).get(req.params.invitationId, req.user.id);
  if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
  if (invitationStatus(table, invitation) !== 'pending') return res.status(409).json({ error: 'Invitation is no longer actionable' });
  const status = req.body.action === 'accept' ? 'accepted' : 'declined';
  db.prepare(`UPDATE ${table} SET status = ?, responded_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, invitation.id);
  if (status === 'accepted') addMembership(isTeam ? 'team_members' : 'project_members', entityColumn, invitation[entityColumn], req.user.id);
  res.json({ message: `Invitation ${status}` });
});

function createTask(req, res) {
  const { teamId, projectId, assigneeId } = req.body;
  if (teamId && !isTeamMember(teamId, req.user.id)) return res.status(403).json({ error: 'You must belong to the selected team' });
  if (projectId && !isProjectMember(projectId, req.user.id)) return res.status(403).json({ error: 'You must belong to the selected project' });
  if (assigneeId && ((!teamId || !isTeamMember(teamId, assigneeId)) && (!projectId || !isProjectMember(projectId, assigneeId)))) return res.status(400).json({ error: 'Assignee must belong to the selected team or project' });
  const result = db.prepare('INSERT INTO tasks (title, description, due_date, status, priority, team_id, project_id, assignee_id, creator_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.body.title, req.body.description || null, req.body.dueDate || null, req.body.status || 'open', req.body.priority || 'medium', teamId || null, projectId || null, assigneeId || null, req.user.id);
  res.status(201).json({ task: formatTask(getTask(result.lastInsertRowid)) });
}
app.post('/api/tasks', validate(schemas.task), createTask);
function listTasks(req, res) {
  const page = getPage(req.query);
  if (!page) return res.status(400).json({ error: 'page must be >= 1 and limit must be between 1 and 100' });
  const filters = ['(t.creator_id = ? OR t.assignee_id = ? OR t.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?) OR t.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?))'];
  const params = [req.user.id, req.user.id, req.user.id, req.user.id];
  const validStatuses = ['open', 'in_progress', 'completed'];
  const validPriorities = ['low', 'medium', 'high'];
  if (req.query.status) { if (!validStatuses.includes(req.query.status)) return res.status(400).json({ error: 'Invalid status filter' }); filters.push('t.status = ?'); params.push(req.query.status); }
  if (req.query.priority) { if (!validPriorities.includes(req.query.priority)) return res.status(400).json({ error: 'Invalid priority filter' }); filters.push('t.priority = ?'); params.push(req.query.priority); }
  if (req.query.assigneeId) { const result = id.safeParse(req.query.assigneeId); if (!result.success) return res.status(400).json({ error: 'Invalid assigneeId filter' }); filters.push('t.assignee_id = ?'); params.push(result.data); }
  for (const [query, column] of [['teamId', 't.team_id'], ['projectId', 't.project_id']]) if (req.query[query]) { const result = id.safeParse(req.query[query]); if (!result.success) return res.status(400).json({ error: `Invalid ${query} filter` }); filters.push(`${column} = ?`); params.push(result.data); }
  if (req.query.search) { filters.push('(t.title LIKE ? OR t.description LIKE ?)'); params.push(`%${req.query.search}%`, `%${req.query.search}%`); }
  const sort = taskSorts[req.query.sort || 'createdAt']; if (!sort) return res.status(400).json({ error: 'Invalid sort field' });
  const order = String(req.query.order || 'desc').toLowerCase(); if (!['asc', 'desc'].includes(order)) return res.status(400).json({ error: 'order must be asc or desc' });
  const total = db.prepare(`SELECT COUNT(*) AS count FROM tasks t WHERE ${filters.join(' AND ')}`).get(...params).count;
  const tasks = db.prepare(`${taskView} WHERE ${filters.join(' AND ')} ORDER BY ${sort} ${order.toUpperCase()}, t.id ${order.toUpperCase()} LIMIT ? OFFSET ?`).all(...params, page.limit, page.offset).map(formatTask);
  res.json({ tasks, pagination: { page: page.page, limit: page.limit, total, totalPages: Math.ceil(total / page.limit) } });
}
app.get('/api/tasks', listTasks);
app.get('/api/tasks/assigned-to-me', (req, res) => { req.query.assigneeId = String(req.user.id); listTasks(req, res); });
app.get('/api/tasks/:taskId', requireTaskAccess, (req, res) => res.json({ task: formatTask(req.task) }));
app.patch('/api/tasks/:taskId', validate(schemas.taskUpdate), requireTaskAccess, (req, res) => {
  if (!canManageTask(req.task, req.user.id) && !(req.body.status && Object.keys(req.body).length === 1 && req.task.assignee_id === req.user.id)) return res.status(403).json({ error: 'You cannot modify this task' });
  const nextTeamId = req.body.teamId === undefined ? req.task.team_id : req.body.teamId;
  const nextProjectId = req.body.projectId === undefined ? req.task.project_id : req.body.projectId;
  const nextAssigneeId = req.body.assigneeId === undefined ? req.task.assignee_id : req.body.assigneeId;
  if (nextTeamId && !isTeamMember(nextTeamId, req.user.id)) return res.status(403).json({ error: 'You must belong to the selected team' });
  if (nextProjectId && !isProjectMember(nextProjectId, req.user.id)) return res.status(403).json({ error: 'You must belong to the selected project' });
  const effectiveAssignee = nextAssigneeId && ((nextTeamId && isTeamMember(nextTeamId, nextAssigneeId)) || (nextProjectId && isProjectMember(nextProjectId, nextAssigneeId))) ? nextAssigneeId : null;
  if (req.body.status && req.body.status !== req.task.status && !transitions[req.task.status].includes(req.body.status)) return res.status(409).json({ error: `Invalid task state transition from ${req.task.status} to ${req.body.status}` });
  const allowed = { title: 'title', description: 'description', dueDate: 'due_date', status: 'status', priority: 'priority', teamId: 'team_id', projectId: 'project_id' };
  const fields = []; const values = [];
  for (const [key, column] of Object.entries(allowed)) if (req.body[key] !== undefined) { fields.push(`${column} = ?`); values.push(req.body[key]); }
  if (req.body.assigneeId !== undefined || req.body.teamId !== undefined || req.body.projectId !== undefined) { fields.push('assignee_id = ?'); values.push(effectiveAssignee); }
  if (!fields.length) return res.status(400).json({ error: 'No changes supplied' });
  if (req.body.status === 'completed') { fields.push('completed_at = CURRENT_TIMESTAMP'); }
  if (req.body.status && req.body.status !== 'completed') { fields.push('completed_at = NULL'); }
  db.prepare(`UPDATE tasks SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, req.params.taskId);
  res.json({ task: formatTask(getTask(req.params.taskId)) });
});
app.delete('/api/tasks/:taskId', requireTaskAccess, (req, res) => { if (!canManageTask(req.task, req.user.id)) return res.status(403).json({ error: 'Only a task manager can delete it' }); db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.taskId); res.status(204).send(); });

app.get('/api/tasks/:taskId/comments', requireTaskAccess, (req, res) => {
  const comments = db.prepare(`SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.task_id = ? ORDER BY c.created_at ASC`).all(req.params.taskId);
  res.json({ comments: comments.map((comment) => ({ ...comment, author: { id: comment.author_id, name: comment.author_name } })) });
});
app.post('/api/tasks/:taskId/comments', requireTaskAccess, validate(schemas.comment), (req, res) => { const result = db.prepare('INSERT INTO comments (task_id, author_id, body) VALUES (?, ?, ?)').run(req.params.taskId, req.user.id, req.body.body); res.status(201).json({ comment: db.prepare('SELECT * FROM comments WHERE id = ?').get(result.lastInsertRowid) }); });
app.patch('/api/tasks/:taskId/comments/:commentId', requireTaskAccess, validate(schemas.comment), (req, res) => { const comment = db.prepare('SELECT * FROM comments WHERE id = ? AND task_id = ?').get(req.params.commentId, req.params.taskId); if (!comment) return res.status(404).json({ error: 'Comment not found' }); if (comment.author_id !== req.user.id) return res.status(403).json({ error: 'Only the comment author can edit it' }); db.prepare('UPDATE comments SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.body, comment.id); res.json({ comment: db.prepare('SELECT * FROM comments WHERE id = ?').get(comment.id) }); });
app.delete('/api/tasks/:taskId/comments/:commentId', requireTaskAccess, (req, res) => { const comment = db.prepare('SELECT * FROM comments WHERE id = ? AND task_id = ?').get(req.params.commentId, req.params.taskId); if (!comment) return res.status(404).json({ error: 'Comment not found' }); if (comment.author_id !== req.user.id && !canManageTask(req.task, req.user.id)) return res.status(403).json({ error: 'You cannot delete this comment' }); db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id); res.status(204).send(); });

app.post('/api/tasks/:taskId/attachments', requireTaskAccess, trackUploadFiles, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A file is required and its type is not allowed' });
  if (!hasValidFileSignature(req.file)) {
    cleanupNewUploadFiles(req);
    return res.status(400).json({ error: 'File content does not match its declared type' });
  }
  const storedName = `${crypto.randomUUID()}${path.extname(req.file.originalname).toLowerCase()}`;
  fs.renameSync(req.file.path, path.join(uploadDir, storedName));
  try {
    const result = db.prepare('INSERT INTO attachments (task_id, uploader_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)').run(req.params.taskId, req.user.id, req.file.originalname, storedName, req.file.mimetype, req.file.size);
    res.status(201).json({ attachment: db.prepare('SELECT * FROM attachments WHERE id = ?').get(result.lastInsertRowid) });
  } catch (error) { cleanupNewUploadFiles(req); throw error; }
});
app.get('/api/tasks/:taskId/attachments', requireTaskAccess, (req, res) => res.json({ attachments: db.prepare('SELECT id, task_id, uploader_id, original_name, mime_type, size, created_at FROM attachments WHERE task_id = ? ORDER BY created_at DESC').all(req.params.taskId) }));
app.get('/api/tasks/:taskId/attachments/:attachmentId', requireTaskAccess, (req, res) => { const attachment = db.prepare('SELECT * FROM attachments WHERE id = ? AND task_id = ?').get(req.params.attachmentId, req.params.taskId); if (!attachment) return res.status(404).json({ error: 'Attachment not found' }); res.download(path.join(uploadDir, attachment.stored_name), attachment.original_name); });
app.delete('/api/tasks/:taskId/attachments/:attachmentId', requireTaskAccess, (req, res) => { const attachment = db.prepare('SELECT * FROM attachments WHERE id = ? AND task_id = ?').get(req.params.attachmentId, req.params.taskId); if (!attachment) return res.status(404).json({ error: 'Attachment not found' }); if (attachment.uploader_id !== req.user.id && !canManageTask(req.task, req.user.id)) return res.status(403).json({ error: 'You cannot delete this attachment' }); db.prepare('DELETE FROM attachments WHERE id = ?').run(attachment.id); fs.rmSync(path.join(uploadDir, attachment.stored_name), { force: true }); res.status(204).send(); });

app.use((error, req, res, _next) => {
  if (error instanceof multer.MulterError) { cleanupNewUploadFiles(req); return res.status(400).json({ error: error.message }); }
  if (error.message === 'Origin is not allowed by CORS') return res.status(403).json({ error: error.message });
  if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Malformed JSON request body' });
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) app.listen(port, () => console.log(`TaskMaster API listening on port ${port}`));
module.exports = app;
module.exports.createAuthRateLimiter = createAuthRateLimiter;
