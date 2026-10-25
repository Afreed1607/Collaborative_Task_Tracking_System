const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databaseFile = path.resolve(process.env.DATABASE_FILE || './data/taskmaster.db');
fs.mkdirSync(path.dirname(databaseFile), { recursive: true });

const db = new DatabaseSync(databaseFile);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');

const migrationDirectory = path.join(__dirname, '..', 'migrations');
function ensureTaskProjectColumn() {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name);
  if (!columns.includes('project_id')) db.exec('ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL');
  if (!columns.includes('completed_at')) db.exec('ALTER TABLE tasks ADD COLUMN completed_at TEXT');
}

for (const file of fs.readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort()) {
  if (file === '002_indexes.sql') ensureTaskProjectColumn();
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(file);
  if (!applied) {
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(migrationDirectory, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(file);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

ensureTaskProjectColumn();

module.exports = db;
