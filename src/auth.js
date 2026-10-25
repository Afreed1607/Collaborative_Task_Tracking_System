const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

const placeholderSecrets = new Set([
  'replace-this-with-a-long-random-secret',
  'change-me',
  'your-secret',
  'secret',
  'changeme'
]);

function validateJwtSecret(value, environment = process.env.NODE_ENV || 'development') {
  const secret = typeof value === 'string' ? value.trim() : '';
  if (secret.length < 32) throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
  if (placeholderSecrets.has(secret.toLowerCase())) throw new Error('JWT_SECRET must not use a placeholder value');
  if (environment === 'production' && /^(test|example|development|replace|change)/i.test(secret)) {
    throw new Error('JWT_SECRET must be a non-placeholder production secret');
  }
  return secret;
}
const secret = validateJwtSecret(process.env.JWT_SECRET);

function createToken(userId) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sessionId, userId, expiresAt.toISOString());
  return jwt.sign({ sub: userId, sid: sessionId }, secret, { expiresIn: '7d' });
}

function authenticate(req, res, next) {
  const header = req.get('authorization');
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(header.slice(7), secret, { algorithms: ['HS256'] });
    const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(payload.sid, payload.sub);
    if (!session || session.revoked_at || new Date(session.expires_at) <= new Date()) {
      return res.status(401).json({ error: 'Session is invalid or expired' });
    }
    const user = db.prepare('SELECT id, name, email, avatar_url, created_at, updated_at FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    req.user = user;
    req.sessionId = payload.sid;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }
}

module.exports = { authenticate, createToken, validateJwtSecret };
