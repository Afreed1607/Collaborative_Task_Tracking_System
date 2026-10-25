# TaskMaster API

TaskMaster is a secure REST API for collaborative task tracking across teams and projects. It uses Node.js 22, Express, SQLite, JWT sessions, Zod validation, and file attachments.

## Requirements

- Node.js 22.5 or newer
- npm
- Docker is optional

## Local setup

```powershell
npm install
Copy-Item .env.example .env
```

Set `JWT_SECRET` in `.env` to a random value of at least 32 characters. Configure `CORS_ORIGINS` as a comma-separated allowlist when the API is called from a browser. The database and upload directories are created automatically.

```powershell
npm start
```

The health endpoint is available at `http://localhost:3000/health`. Interactive Swagger UI is available at `http://localhost:3000/docs/`, with the source specification at `/openapi.json`.

## Test and quality checks

```powershell
npm test
npm run validate:openapi
npm audit --omit=dev
```

Tests use Node's built-in test runner and Supertest. The suite covers unit validation, authentication, project invitations, task pagination/state transitions, comment lifecycle, authorization, CORS, and security headers.

Authentication endpoints use configurable rate limits through `AUTH_RATE_LIMIT_WINDOW_MS` and `AUTH_RATE_LIMIT_MAX`. Production requires a non-placeholder `JWT_SECRET` and an explicit `CORS_ORIGINS` allowlist.

For a quick manual smoke check after starting the API:

```powershell
Invoke-RestMethod http://localhost:3000/health
Invoke-WebRequest http://localhost:3000/docs/ | Select-Object -ExpandProperty StatusCode
```

## Docker

```powershell
docker build -t taskmaster-api .
docker run --rm -p 3000:3000 `
  -e JWT_SECRET="replace-with-a-long-random-secret" `
  -e CORS_ORIGINS="http://localhost:3000" `
  -v taskmaster-data:/app/data `
  -v taskmaster-uploads:/app/uploads `
  taskmaster-api
```

Or use Compose with named volumes:

```powershell
$env:JWT_SECRET="replace-with-a-long-random-secret"
docker compose up --build
docker compose down
```

## Authentication

Register or log in, then send `Authorization: Bearer <token>` to protected endpoints. Sessions expire after seven days and can be explicitly revoked with logout. Tokens are verified with an explicit HS256 algorithm.

## API overview

### Authentication and profiles

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `PATCH /api/me`

### Teams and projects

- `POST /api/teams`, `GET /api/teams`
- `PATCH/DELETE /api/teams/:teamId` (owner only)
- `GET /api/teams/:teamId/members`
- `POST /api/teams/:teamId/invitations`
- `POST /api/projects`, `GET /api/projects`
- `PATCH/DELETE /api/projects/:projectId` (owner only)
- `GET /api/projects/:projectId/members`
- `POST /api/projects/:projectId/invitations`
- `GET /api/invitations`
- `POST /api/invitations/:type/:invitationId/respond` with `{ "action": "accept" }` or `{ "action": "decline" }`

Invitations expire automatically when read or acted on. Owners can set an expiry between one and 30 days. Accepted invitations create membership records; declined and expired invitations do not.

### Tasks

- `POST /api/tasks`
- `GET /api/tasks`
- `GET /api/tasks/assigned-to-me`
- `GET /api/tasks/:taskId`
- `PATCH /api/tasks/:taskId`
- `DELETE /api/tasks/:taskId`

Task listing supports `page`, `limit` (maximum 100), `status`, `priority`, `assigneeId`, `teamId`, `projectId`, `search`, `sort` (`dueDate`, `createdAt`, `updatedAt`, `title`, `priority`, `status`), and `order` (`asc` or `desc`). Valid transitions are `open -> in_progress -> completed`; completed tasks cannot transition further. Completing a task records `completedAt`.

Changing a task's team or project verifies membership and clears an assignee who is no longer a member of the new organization.

### Comments and attachments

- `GET/POST /api/tasks/:taskId/comments`
- `PATCH/DELETE /api/tasks/:taskId/comments/:commentId`
- `GET/POST /api/tasks/:taskId/attachments`
- `GET/DELETE /api/tasks/:taskId/attachments/:attachmentId`

Only comment authors can edit comments. Authors and task managers can delete comments or attachments. Uploads are limited to 10 MB and an explicit allowlist of safe MIME types.
Uploaded content is also checked against file signatures or valid text content; mismatched or spoofed files are rejected.

## Database migrations

Migrations are stored in `migrations/` and applied in filename order on startup. A `schema_migrations` table records applied versions. The startup path also upgrades the original pre-migration database by adding the project task column when needed.

## Repository hygiene

`.env`, SQLite databases/WAL files, uploads, `node_modules`, test databases, and build/runtime artifacts are excluded by `.gitignore`. Do not commit credentials or user-uploaded files.

## Submission hygiene

Do not submit `.env`, `node_modules`, local SQLite databases/WAL/SHM files, uploads, logs, temporary files, or generated archives. `.gitignore` excludes these paths while retaining `.env.example`, `package-lock.json`, source, migrations, tests, CI, Docker files, and documentation.
