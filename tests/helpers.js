const fs = require('node:fs');
const path = require('node:path');

const testDatabase = path.resolve('./data/test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-tests-123';
process.env.DATABASE_FILE = testDatabase;
process.env.UPLOAD_DIR = path.resolve('./uploads/test');
process.env.AUTH_RATE_LIMIT_MAX = '100';
fs.rmSync(testDatabase, { force: true });
fs.rmSync(`${testDatabase}-shm`, { force: true });
fs.rmSync(`${testDatabase}-wal`, { force: true });
fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

const app = require('../src/server');
const db = require('../src/db');
const supertest = require('supertest');
const request = {
  get: (url) => supertest(app).get(url),
  post: (url) => supertest(app).post(url)
};

async function register(name, email) {
  const response = await request.post('/api/auth/register').send({ name, email, password: 'Password123!' });
  return { ...response.body, response };
}

function auth(token) {
  return {
    get: (url) => supertest(app).get(url).set('Authorization', `Bearer ${token}`),
    post: (url) => supertest(app).post(url).set('Authorization', `Bearer ${token}`),
    patch: (url) => supertest(app).patch(url).set('Authorization', `Bearer ${token}`),
    delete: (url) => supertest(app).delete(url).set('Authorization', `Bearer ${token}`),
    attach: (url, field, file, filename) => supertest(app).post(url).set('Authorization', `Bearer ${token}`).attach(field, file, filename)
  };
}

module.exports = { app, db, request, register, auth };
