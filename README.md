# Commonplace

Commonplace is a real-time collaborative workspace application built with Next.js on the frontend and an Express + Prisma + PostgreSQL + Redis + Socket.IO API on the backend.

It supports:
- Workspace creation and member management
- Board, list, and task workflows
- Role-based permissions
- Invitations and member onboarding
- Search, activity feed, and filtered views
- Real-time updates across clients through Socket.IO

---

## Project structure

```text
realtime-workspace/
├── .env.example              # environment variable template
├── .gitignore
├── Dockerfile                # frontend image
├── docker-compose.yml        # local Postgres + Redis + API + web services
├── next.config.ts
├── package.json              # frontend scripts and dependencies
├── postcss.config.mjs
├── tsconfig.json
├── src/
│   └── app/
│       ├── globals.css
│       ├── layout.tsx
│       └── page.tsx         # main collaborative UI
├── api/
│   ├── Dockerfile
│   ├── package.json          # API scripts and dependencies
│   ├── prisma/
│   │   ├── schema.prisma     # PostgreSQL schema and tenant model
│   │   ├── seed.mjs          # demo user / workspace seeding
│   │   └── migrations/
│   └── src/
│       ├── index.ts          # Express API + Socket.IO server
│       ├── policy.ts         # role and permission logic
│       ├── rank.ts           # fractional ordering for list/task ranks
│       ├── integration.test.ts
│       ├── socketRooms.ts    # board room join/leave logic
│       └── socketRooms.test.ts
└── README.md
```

---

## Architecture

### High-level flow

```mermaid
flowchart LR
    A[Next.js Frontend] -->|HTTP + JWT| B[Express API]
    A -->|Socket.IO| C[Realtime Board Events]
    B --> D[Prisma ORM]
    D --> E[PostgreSQL]
    B --> F[Redis]
    B --> G[BullMQ Worker]
    C --> A
```

### Core components

- Frontend: Next.js app renders the board UI and talks to the API through REST calls and Socket.IO events.
- Backend API: Express server handles auth, workspaces, boards, permissions, lists, tasks, invite flows, search, and activity.
- Database: PostgreSQL stores users, memberships, workspaces, boards, tasks, activity, and refresh sessions.
- Redis: caches summary data and supports the background job queue.
- Socket.IO: broadcasts board updates to all users connected to the same workspace/board room.

### Security model

- JWT access tokens expire in 15 minutes.
- Refresh tokens are stored as hashes in an httpOnly cookie.
- Role checks are enforced in the backend through a centralized policy layer.
- Workspace and board access is scoped to authenticated membership.
- Task/list update operations use optimistic version checks to reject stale edits with 409 responses.

---

## Tech stack

- Next.js 16 + React 19 + TypeScript
- Express 5 + Socket.IO
- Prisma ORM with PostgreSQL
- Redis and BullMQ
- Docker Compose for local orchestration
- Zod validation

---

## Installation

### Prerequisites

- Node.js 20+
- Docker Desktop (recommended for local PostgreSQL and Redis)

### 1) Configure environment variables

Create a local environment file:

```bash
cp .env.example .env
```

Update the values as needed:

```env
DATABASE_URL=postgresql://workspace:workspace@localhost:5432/workspace?schema=public
REDIS_URL=redis://localhost:6379
ACCESS_TOKEN_SECRET=replace-this-with-a-random-secret-at-least-32-characters
WEB_ORIGIN=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
SMTP_URL=
SMTP_FROM=Commonplace <no-reply@example.com>
DEMO_ACCOUNT_PASSWORD=
```

For local development, `ACCESS_TOKEN_SECRET` should be at least 32 characters long.

### 2) Start the application with Docker

```bash
docker compose up --build
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- API on port 4000
- Web app on port 3000

Open:
- Frontend: http://localhost:3000
- API health: http://localhost:4000/health

### 3) Run manually without Docker

Install dependencies:

```bash
npm install
cd api && npm install && cd ..
```

Then run the backend and frontend in separate terminals:

```bash
cd api
npm run db:migrate
npm run dev
```

```bash
npm run dev
```

---

## Demo accounts and seed data

To seed demo accounts for local testing:

```bash
export DEMO_ACCOUNT_PASSWORD="YourStrongPassword123"
cd api
npm run db:seed
```

This creates:
- Email: owner.demo@example.com
- Role: OWNER
- Workspace: Commonplace Demo

and
- Email: member.demo@example.com
- Role: MEMBER

Use the same password value for both demo accounts.

> Demo accounts are intended for local evaluation only and should not be used in public production environments.

---

## Working flow

### 1) Sign up or sign in
The user creates an account or logs in. The API creates a refresh-token session and returns an access token to the frontend.

### 2) Workspace and board selection
The frontend calls the workspace and board endpoints, then loads the currently selected board.

### 3) Board interaction
Users can create/edit/move lists and tasks. Each mutation is validated, checked for stale versions, and persisted in PostgreSQL.

### 4) Real-time sync
After a successful mutation, the API emits a Socket.IO event such as:
- task:created
- task:updated
- task:deleted
- list:created
- list:updated

All connected clients in the same board room receive the payload and update their local board state.

### 5) Invite flow
Owners/Admins can invite teammates. The backend generates a secure invite link and stores the invite record. When the invited user signs up, the backend links them to the workspace and assigns the requested role.

### 6) Activity and search
The app records workspace activity and supports filtered search across task title, description, assignee, label, and status.

---

## Validation commands

```bash
# Root app
npm run build
npm run lint

# API
cd api
npm run build
npm test

# Optional full integration tests (requires env values)
RUN_INTEGRATION_TESTS=true npm test
```

The project already confirms the web app and API compile successfully as part of the integrated setup.

---

## Deployment notes

The repository includes provider configuration for split deployment:

- `vercel.json` deploys the Next.js frontend from the repository root.
- `render.yaml` provisions the Render API, PostgreSQL database, and Redis key-value service.
- `api/Dockerfile` builds and starts the Express API and applies Prisma migrations before startup.

### Render backend

Create a Render Blueprint from this repository or apply `render.yaml`. Set `WEB_ORIGIN` to the final Vercel URL. Render supplies `DATABASE_URL` and `REDIS_URL` from the provisioned services, and the blueprint generates `ACCESS_TOKEN_SECRET`.

The API health check is:

```text
https://<render-api-domain>/health
```

### Vercel frontend

Deploy the repository root as a Next.js project and set `NEXT_PUBLIC_API_URL` to the Render API URL, for example:

```text
https://<render-api-domain>
```

After the Vercel domain is known, update Render's `WEB_ORIGIN` to that exact origin and redeploy the API. This is required for browser requests, refresh cookies, and Socket.IO connections.

Required production environment variables are:

- DATABASE_URL
- REDIS_URL
- ACCESS_TOKEN_SECRET
- WEB_ORIGIN
- NEXT_PUBLIC_API_URL
- SMTP_URL / SMTP_FROM

### Terminal deployment

Vercel can be deployed from the repository root with the Vercel CLI:

```bash
npm install --global vercel
vercel login
vercel --prod
```

Render Blueprints are applied from the Render dashboard or Render API. A Render API key is required for unattended terminal automation. Never commit provider tokens or production secrets to the repository.
