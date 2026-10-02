import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type RequestHandler } from "express";
import helmet from "helmet";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import nodemailer from "nodemailer";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { Server as SocketServer } from "socket.io";
import { z } from "zod";
import { Prisma, PrismaClient } from "@prisma/client";
import { canAssignRole, canManageMember, hasPermission, type Permission, type WorkspaceRole } from "./policy.js";
import { rankBetween } from "./rank.js";

const prisma = new PrismaClient();
const app = express();
const httpServer = createServer(app);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const configuredAccessSecret = process.env.ACCESS_TOKEN_SECRET;
const accessSecret = configuredAccessSecret ?? "local-only-change-this-access-secret-32";
const refreshCookie = "workspace_refresh";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const redisOptions = { maxRetriesPerRequest: 1, connectTimeout: 500, lazyConnect: true };
const cache = new Redis(redisUrl, redisOptions);
const queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
const notifications = new Queue("workspace-notifications", {
  connection: queueConnection,
  defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 500, removeOnFail: 1000 },
});
const emailTransport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
const io = new SocketServer(httpServer, { cors: { origin: webOrigin, credentials: true } });

type AuthClaims = JwtPayload & { sub: string };

function routeParam(request: express.Request, key: string): string {
  const value = request.params[key];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

if (process.env.NODE_ENV === "production" && (!configuredAccessSecret || configuredAccessSecret.length < 32)) {
  throw new Error("ACCESS_TOKEN_SECRET must be at least 32 characters in production");
}

cache.on("error", () => undefined);
queueConnection.on("error", () => undefined);

app.use(helmet());
app.use(cors({ origin: webOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, accessSecret, { expiresIn: "15m" });
}

function setRefreshCookie(response: express.Response, token: string): void {
  response.cookie(refreshCookie, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    path: "/auth",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(response: express.Response): void {
  response.clearCookie(refreshCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    path: "/auth",
  });
}

const authenticate: RequestHandler = (request, response, next) => {
  const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const claims = jwt.verify(bearer, accessSecret) as AuthClaims;
    response.locals.userId = claims.sub;
    next();
  } catch {
    response.status(401).json({ error: "Access token is invalid or expired" });
  }
};

function requireWorkspacePermission(permission: Permission): RequestHandler {
  return async (request, response, next) => {
    try {
      const workspaceId = routeParam(request, "workspaceId");
      const membership = await prisma.membership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: response.locals.userId as string } },
        select: { role: true },
      });
      if (!membership) {
        response.status(404).json({ error: "Workspace not found" });
        return;
      }
      if (!hasPermission(membership.role, permission)) {
        response.status(403).json({ error: "Insufficient workspace permissions" });
        return;
      }
      response.locals.workspaceRole = membership.role;
      next();
    } catch (error) {
      next(error);
    }
  };
}

const signupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128),
  workspaceName: z.string().trim().min(1).max(80).optional(),
  inviteToken: z.string().min(20).optional(),
}).refine((input) => Boolean(input.workspaceName || input.inviteToken), { message: "Workspace name or invitation token is required" });
const credentialsSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(128) });
const taskCreateSchema = z.object({
  listId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).default(""),
  status: z.enum(["TODO", "IN_PROGRESS", "DONE"]).default("TODO"),
  label: z.string().trim().max(40).nullable().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
});
const taskUpdateSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10000).optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "DONE"]).optional(),
  label: z.string().trim().max(40).nullable().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  listId: z.string().min(1).optional(),
  previousId: z.string().min(1).nullable().optional(),
  nextId: z.string().min(1).nullable().optional(),
});
const listCreateSchema = z.object({ title: z.string().trim().min(1).max(80) });
const listUpdateSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(80).optional(),
  previousId: z.string().min(1).nullable().optional(),
  nextId: z.string().min(1).nullable().optional(),
});
const inviteSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
});
const roleUpdateSchema = z.object({ role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]) });

app.get("/health", (_request, response) => response.json({ status: "ok" }));

app.post("/auth/signup", async (request, response, next) => {
  try {
    const input = signupSchema.parse(request.body);
    const email = input.email.toLowerCase();
    const passwordHash = await bcrypt.hash(input.password, 12);
    const workspaceName = input.workspaceName ?? "Workspace";
    const invited = input.inviteToken
      ? await prisma.invite.findUnique({ where: { tokenHash: tokenHash(input.inviteToken) } })
      : null;
    if (input.inviteToken && (!invited || invited.acceptedAt || invited.expiresAt <= new Date() || invited.email.toLowerCase() !== email)) {
      response.status(400).json({ error: "Invitation is invalid, expired, or belongs to another email" });
      return;
    }
    if (!invited && !input.workspaceName) {
      response.status(400).json({ error: "Workspace name is required" });
      return;
    }
    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({ data: { name: input.name, email, passwordHash } });
      if (invited) {
        const claimed = await tx.invite.updateMany({
          where: { id: invited.id, acceptedAt: null, expiresAt: { gt: new Date() } },
          data: { acceptedAt: new Date() },
        });
        if (claimed.count !== 1) throw new Error("INVITE_CLAIM_CONFLICT");
        await tx.membership.create({ data: { userId: createdUser.id, workspaceId: invited.workspaceId, role: invited.role } });
        await tx.activity.create({ data: { workspaceId: invited.workspaceId, actorId: createdUser.id, action: "member.added", subjectId: createdUser.id, metadata: { role: invited.role } } });
        return { ...createdUser, workspaceId: invited.workspaceId, boardId: null };
      }
      const workspace = await tx.workspace.create({ data: { name: workspaceName } });
      await tx.membership.create({ data: { userId: createdUser.id, workspaceId: workspace.id, role: "OWNER" } });
      const board = await tx.board.create({ data: { workspaceId: workspace.id, name: "Product board" } });
      let previousRank: string | null = null;
      for (const title of ["To do", "In progress", "Done"]) {
        previousRank = rankBetween(previousRank, null);
        await tx.taskList.create({ data: { workspaceId: workspace.id, boardId: board.id, title, rank: previousRank } });
      }
      return { ...createdUser, workspaceId: workspace.id, boardId: board.id };
    });
    const refreshToken = randomBytes(32).toString("base64url");
    await prisma.refreshSession.create({
      data: { userId: user.id, tokenHash: tokenHash(refreshToken), expiresAt: new Date(Date.now() + 30 * 86400000) },
    });
    setRefreshCookie(response, refreshToken);
    response.status(201).json({ accessToken: createAccessToken(user.id), user: { id: user.id, name: user.name, email: user.email }, workspaceId: user.workspaceId, boardId: user.boardId });
  } catch (error) {
    if (error instanceof Error && error.message === "INVITE_CLAIM_CONFLICT") {
      response.status(409).json({ error: "Invitation was already accepted" });
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      response.status(409).json({ error: "An account with this email already exists" });
      return;
    }
    next(error);
  }
});

app.post("/auth/login", async (request, response, next) => {
  try {
    const input = credentialsSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      response.status(401).json({ error: "Email or password is incorrect" });
      return;
    }
    const refreshToken = randomBytes(32).toString("base64url");
    await prisma.refreshSession.create({
      data: { userId: user.id, tokenHash: tokenHash(refreshToken), expiresAt: new Date(Date.now() + 30 * 86400000) },
    });
    setRefreshCookie(response, refreshToken);
    response.json({ accessToken: createAccessToken(user.id), user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/refresh", async (request, response, next) => {
  try {
    const rawToken = request.cookies[refreshCookie] as string | undefined;
    if (!rawToken) {
      response.status(401).json({ error: "Refresh token required" });
      return;
    }
    const existing = await prisma.refreshSession.findUnique({ where: { tokenHash: tokenHash(rawToken) } });
    if (!existing) {
      clearRefreshCookie(response);
      response.status(401).json({ error: "Refresh token is invalid" });
      return;
    }
    if (existing.revokedAt) {
      await prisma.refreshSession.updateMany({ where: { userId: existing.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      clearRefreshCookie(response);
      response.status(401).json({ error: "Refresh token reuse detected; sessions revoked" });
      return;
    }
    if (existing.expiresAt <= new Date()) {
      clearRefreshCookie(response);
      response.status(401).json({ error: "Refresh token expired" });
      return;
    }
    const nextToken = randomBytes(32).toString("base64url");
    const rotated = await prisma.$transaction(async (tx) => {
      const result = await tx.refreshSession.updateMany({ where: { id: existing.id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (result.count !== 1) return false;
      await tx.refreshSession.create({ data: { userId: existing.userId, tokenHash: tokenHash(nextToken), expiresAt: new Date(Date.now() + 30 * 86400000) } });
      return true;
    });
    if (!rotated) {
      response.status(409).json({ error: "Refresh token was already rotated" });
      return;
    }
    setRefreshCookie(response, nextToken);
    response.json({ accessToken: createAccessToken(existing.userId) });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/logout", async (request, response, next) => {
  try {
    const rawToken = request.cookies[refreshCookie] as string | undefined;
    if (rawToken) {
      await prisma.refreshSession.updateMany({ where: { tokenHash: tokenHash(rawToken), revokedAt: null }, data: { revokedAt: new Date() } });
    }
    clearRefreshCookie(response);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/auth/me", authenticate, async (_request, response, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: response.locals.userId as string },
      select: { id: true, name: true, email: true },
    });
    if (!user) {
      response.status(401).json({ error: "Account not found" });
      return;
    }
    response.json(user);
  } catch (error) {
    next(error);
  }
});

app.get("/workspaces", authenticate, async (_request, response, next) => {
  try {
    const workspaces = await prisma.membership.findMany({
      where: { userId: response.locals.userId as string },
      select: { role: true, workspace: { select: { id: true, name: true } } },
    });
    response.json(workspaces.map(({ workspace, role }) => ({ ...workspace, role })));
  } catch (error) {
    next(error);
  }
});

app.get("/workspaces/:workspaceId/boards/:boardId", authenticate, requireWorkspacePermission("read"), async (request, response, next) => {
  try {
    const workspaceId = routeParam(request, "workspaceId");
    const boardId = routeParam(request, "boardId");
    const board = await prisma.board.findFirst({
      where: { id: boardId, workspaceId },
      include: { lists: { orderBy: { rank: "asc" }, include: { tasks: { orderBy: { rank: "asc" } } } } },
    });
    if (!board) {
      response.status(404).json({ error: "Board not found" });
      return;
    }
    response.json(board);
  } catch (error) {
    next(error);
  }
});

app.get("/workspaces/:workspaceId/boards", authenticate, requireWorkspacePermission("read"), async (request, response, next) => {
  try {
    const workspaceId = routeParam(request, "workspaceId");
    const boards = await prisma.board.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
    response.json(boards);
  } catch (error) {
    next(error);
  }
});

app.post("/workspaces/:workspaceId/boards/:boardId/lists", authenticate, requireWorkspacePermission("write"), async (request, response, next) => {
  try {
    const workspaceId = routeParam(request, "workspaceId");
    const boardId = routeParam(request, "boardId");
    const input = listCreateSchema.parse(request.body);
    const board = await prisma.board.findFirst({ where: { id: boardId, workspaceId } });
    if (!board) {
      response.status(404).json({ error: "Board not found" });
      return;
    }
    const created = await prisma.$transaction(async (tx) => {
      const last = await tx.taskList.findFirst({ where: { workspaceId, boardId }, orderBy: { rank: "desc" }, select: { rank: true } });
      const list = await tx.taskList.create({ data: { workspaceId, boardId, title: input.title, rank: rankBetween(last?.rank ?? null, null) } });
      await tx.activity.create({ data: { workspaceId, actorId: response.locals.userId as string, action: "list.created", subjectId: list.id } });
      return list;
    });
    const createdWithTasks = { ...created, tasks: [] };
    io.to(boardRoom(workspaceId, boardId)).emit("list:created", createdWithTasks);
    response.status(201).json(createdWithTasks);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      response.status(409).json({ error: "List order changed concurrently; reload and retry" });
      return;
    }
    next(error);
  }
});

app.patch("/workspaces/:workspaceId/boards/:boardId/lists/:listId", authenticate, requireWorkspacePermission("write"), async (request, response, next) => {
  try {
    const workspaceId = routeParam(request, "workspaceId");
    const boardId = routeParam(request, "boardId");
    const listId = routeParam(request, "listId");
    const input = listUpdateSchema.parse(request.body);
    const original = await prisma.taskList.findFirst({ where: { id: listId, workspaceId, boardId } });
    if (!original) {
      response.status(404).json({ error: "List not found" });
      return;
    }
    if (original.version !== input.version) {
      response.status(409).json({ error: "List changed since it was loaded", currentVersion: original.version });
      return;
    }
    const isReordering = input.previousId !== undefined || input.nextId !== undefined;
    let rank = original.rank;
    if (isReordering) {
      const neighbors = await prisma.taskList.findMany({
        where: { workspaceId, boardId, id: { not: listId } },
        orderBy: { rank: "asc" },
        select: { id: true, rank: true },
      });
      const nextIndex = input.nextId ? neighbors.findIndex((item) => item.id === input.nextId) : -1;
      const previousIndex = input.previousId ? neighbors.findIndex((item) => item.id === input.previousId) : -1;
      if ((input.nextId && nextIndex < 0) || (input.previousId && previousIndex < 0) || (nextIndex >= 0 && previousIndex >= 0 && nextIndex !== previousIndex + 1)) {
        response.status(409).json({ error: "List neighbors changed; reload the board and retry" });
        return;
      }
      const previous = nextIndex >= 0 ? neighbors[nextIndex - 1] : previousIndex >= 0 ? neighbors[previousIndex] : neighbors.at(-1);
      const next = nextIndex >= 0 ? neighbors[nextIndex] : previousIndex >= 0 ? neighbors[previousIndex + 1] : undefined;
      rank = rankBetween(previous?.rank ?? null, next?.rank ?? null);
    }
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.taskList.updateMany({
        where: { id: listId, workspaceId, boardId, version: input.version },
        data: { ...(input.title !== undefined ? { title: input.title } : {}), rank, version: { increment: 1 } },
      });
      if (result.count !== 1) return null;
      const list = await tx.taskList.findUniqueOrThrow({ where: { id: listId }, include: { tasks: { orderBy: { rank: "asc" } } } });
      await tx.activity.create({
        data: { workspaceId, actorId: response.locals.userId as string, action: isReordering ? "list.moved" : "list.updated", subjectId: listId },
      });
      return list;
    });
    if (!updated) {
      response.status(409).json({ error: "List changed concurrently; reload and retry" });
      return;
    }
    io.to(boardRoom(workspaceId, boardId)).emit("list:updated", updated);
    response.json(updated);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      response.status(409).json({ error: "List order changed concurrently; reload and retry" });
      return;
    }
    next(error);
  }
});

app.get("/workspaces/:workspaceId/summary", authenticate, requireWorkspacePermission("read"), async (request, response, next) => {
  const workspaceId = routeParam(request, "workspaceId");
  const cacheKey = `workspace-summary:${workspaceId}`;
  try {
    const cached = await cache.get(cacheKey).catch(() => null);
    if (cached) {
      response.json(JSON.parse(cached));
      return;
    }
    const [boardCount, taskCount, memberCount] = await Promise.all([
      prisma.board.count({ where: { workspaceId } }),
      prisma.task.count({ where: { workspaceId } }),
      prisma.membership.count({ where: { workspaceId } }),
    ]);
    const summary = { boardCount, taskCount, memberCount };
    await cache.set(cacheKey, JSON.stringify(summary), "EX", 30).catch(() => undefined);
    response.json(summary);
  } catch (error) {
    next(error);
  }
});

app.get("/workspaces/:workspaceId/search", authenticate, requireWorkspacePermission("read"), async (request, response, next) => {
  try {
    const workspaceId = routeParam(request, "workspaceId");
    const query = z.string().trim().max(100).optional().parse(request.query.q) ?? "";
    const page = z.coerce.number().int().min(1).default(1).parse(request.query.page);
    const pageSize = z.coerce.number().int().min(1).max(50).default(20).parse(request.query.pageSize);
    const assigneeId = z.string().min(1).optional().parse(request.query.assigneeId) ?? null;
    const label = z.string().min(1).optional().parse(request.query.label) ?? null;
    const status = z.enum(["TODO", "IN_PROGRESS", "DONE"]).optional().parse(request.query.status) ?? null;
    const offset = (page - 1) * pageSize;
    const [matches, totals] = await Promise.all([
      prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Task"
        WHERE "workspaceId" = ${workspaceId}
          AND (${query} = '' OR to_tsvector('english', "title" || ' ' || "description") @@ websearch_to_tsquery('english', ${query}))
          AND (${assigneeId}::text IS NULL OR "assigneeId" = ${assigneeId})
          AND (${label}::text IS NULL OR "label" = ${label})
          AND (${status}::text IS NULL OR "status"::text = ${status})
        ORDER BY "updatedAt" DESC, "id" DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS "count" FROM "Task"
        WHERE "workspaceId" = ${workspaceId}
          AND (${query} = '' OR to_tsvector('english', "title" || ' ' || "description") @@ websearch_to_tsquery('english', ${query}))
          AND (${assigneeId}::text IS NULL OR "assigneeId" = ${assigneeId})
          AND (${label}::text IS NULL OR "label" = ${label})
          AND (${status}::text IS NULL OR "status"::text = ${status})
      `,
    ]);
    const items = await prisma.task.findMany({
      where: { workspaceId, id: { in: matches.map(({ id }) => id) } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    response.json({ items, total: Number(totals[0]?.count ?? 0), page, pageSize });
  } catch (error) {
    next(error);
  }
});

app.post("/workspaces/:workspaceId/boards/:boardId/tasks", authenticate, requireWorkspacePermission("write"), async (request, response, next) => {
  try {
    const workspaceId = routeParam(request, "workspaceId");
    const boardId = routeParam(request, "boardId");
    const input = taskCreateSchema.parse(request.body);
    const list = await prisma.taskList.findFirst({ where: { id: input.listId, boardId, workspaceId } });
    if (!list) {
      response.status(404).json({ error: "List not found" });
      return;
    }
    if (input.assigneeId) {
      const assignee = await prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: input.assigneeId } } });
      if (!assignee) {
        response.status(400).json({ error: "Assignee must be a member of this workspace" });
        return;
      }
    }
    const task = await prisma.$transaction(async (tx) => {
      const last = await tx.task.findFirst({ where: { listId: list.id }, orderBy: { rank: "desc" }, select: { rank: true } });
      const created = await tx.task.create({ data: { ...input, workspaceId: list.workspaceId, rank: rankBetween(last?.rank ?? null, null), listId: list.id } });
      await tx.activity.create({ data: { workspaceId: list.workspaceId, actorId: response.locals.userId as string, action: "task.created", subjectId: created.id } });
      return created;
    });
    void invalidateSummary(list.workspaceId);
    void notifications.add("task-created", { workspaceId: list.workspaceId, boardId: list.boardId, taskId: task.id }).catch(() => undefined);
    io.to(boardRoom(list.workspaceId, list.boardId)).emit("task:created", task);
    response.status(201).json(task);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      response.status(409).json({ error: "Task order changed concurrently; reload and retry" });
      return;
    }
    next(error);
  }
});

app.patch("/workspaces/:workspaceId/boards/:boardId/tasks/:taskId", authenticate, requireWorkspacePermission("write"), async (request, response, next) => {
  try {
    const input = taskUpdateSchema.parse(request.body);
    const workspaceId = routeParam(request, "workspaceId");
    const boardId = routeParam(request, "boardId");
    const taskId = routeParam(request, "taskId");
    const original = await prisma.task.findFirst({
      where: { id: taskId, workspaceId, list: { boardId, workspaceId } },
      include: { list: true },
    });
    if (!original) {
      response.status(404).json({ error: "Task not found" });
      return;
    }
    if (original.version !== input.version) {
      response.status(409).json({ error: "Task changed since it was loaded", currentVersion: original.version });
      return;
    }
    const targetListId = input.listId ?? original.listId;
    if (input.assigneeId) {
      const assignee = await prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: input.assigneeId } } });
      if (!assignee) {
        response.status(400).json({ error: "Assignee must be a member of this workspace" });
        return;
      }
    }
    const targetList = await prisma.taskList.findFirst({ where: { id: targetListId, workspaceId, boardId } });
    if (!targetList) {
      response.status(404).json({ error: "Destination list not found" });
      return;
    }
    const neighbors = await prisma.task.findMany({
      where: { listId: targetListId, workspaceId, id: { not: original.id } },
      orderBy: { rank: "asc" },
      select: { id: true, rank: true },
    });
    const nextIndex = input.nextId ? neighbors.findIndex((item) => item.id === input.nextId) : -1;
    const previousIndex = input.previousId ? neighbors.findIndex((item) => item.id === input.previousId) : -1;
    if ((input.nextId && nextIndex < 0) || (input.previousId && previousIndex < 0) || (nextIndex >= 0 && previousIndex >= 0 && nextIndex !== previousIndex + 1)) {
      response.status(409).json({ error: "Task neighbors changed; reload the board and retry" });
      return;
    }
    const previous = previousIndex >= 0 ? neighbors[previousIndex] : nextIndex >= 0 ? neighbors[nextIndex - 1] : neighbors.at(-1);
    const next = nextIndex >= 0 ? neighbors[nextIndex] : previousIndex >= 0 ? neighbors[previousIndex + 1] : undefined;
    const isReordering = input.listId !== undefined || input.previousId !== undefined || input.nextId !== undefined;
    const rank = isReordering ? rankBetween(previous?.rank ?? null, next?.rank ?? null) : original.rank;
    const changed = await prisma.$transaction(async (tx) => {
      const result = await tx.task.updateMany({
        where: { id: original.id, workspaceId, version: input.version },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
          listId: targetListId,
          rank,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) return null;
      const updated = await tx.task.findUniqueOrThrow({ where: { id: original.id } });
      await tx.activity.create({
        data: {
          workspaceId,
          actorId: response.locals.userId as string,
          action: original.listId === targetListId ? "task.updated" : "task.moved",
          subjectId: original.id,
          metadata: { fromListId: original.listId, toListId: targetListId } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
    if (!changed) {
      response.status(409).json({ error: "Task changed concurrently; reload and retry" });
      return;
    }
    void invalidateSummary(workspaceId);
    io.to(boardRoom(workspaceId, boardId)).emit("task:updated", changed);
    response.json(changed);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      response.status(409).json({ error: "Concurrent ordering conflict; reload and retry" });
      return;
    }
    next(error);
  }
});

app.delete("/workspaces/:workspaceId/boards/:boardId/tasks/:taskId", authenticate, requireWorkspacePermission("write"), async (request, response, next) => {
  try {
    const workspaceId = routeParam(request, "workspaceId");
    const boardId = routeParam(request, "boardId");
    const taskId = routeParam(request, "taskId");
    const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId, list: { boardId } } });
    if (!task) {
      response.status(404).json({ error: "Task not found" });
      return;
    }
    await prisma.$transaction([
      prisma.activity.create({ data: { workspaceId, actorId: response.locals.userId as string, action: "task.deleted", subjectId: task.id, metadata: { title: task.title } } }),
      prisma.task.delete({ where: { id: task.id } }),
    ]);
    void invalidateSummary(workspaceId);
    io.to(boardRoom(workspaceId, boardId)).emit("task:deleted", { id: task.id });
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/workspaces/:workspaceId/members", authenticate, requireWorkspacePermission("read"), async (request, response, next) => {
  try {
    const workspaceId = routeParam(request, "workspaceId");
    const members = await prisma.membership.findMany({
      where: { workspaceId },
      orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
      select: { role: true, joinedAt: true, user: { select: { id: true, name: true, email: true } } },
    });
    response.json(members.map(({ user, role, joinedAt }) => ({ ...user, role, joinedAt })));
  } catch (error) {
    next(error);
  }
});

app.post("/workspaces/:workspaceId/invites", authenticate, requireWorkspacePermission("manageMembers"), async (request, response, next) => {
  try {
    const input = inviteSchema.parse(request.body);
    const workspaceId = routeParam(request, "workspaceId");
    const actorRole = response.locals.workspaceRole as WorkspaceRole;
    if (!canAssignRole(actorRole, input.role)) {
      response.status(403).json({ error: "You cannot invite a member with that role" });
      return;
    }
    const email = input.email.toLowerCase();
    const existingMember = await prisma.membership.findFirst({ where: { workspaceId, user: { email } } });
    if (existingMember) {
      response.status(409).json({ error: "That user is already a workspace member" });
      return;
    }
    const now = new Date();
    const pendingInvite = await prisma.invite.findFirst({ where: { workspaceId, email, acceptedAt: null, expiresAt: { gt: now } } });
    if (pendingInvite) {
      response.status(409).json({ error: "An active invitation already exists for that email" });
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const invite = await prisma.$transaction(async (tx) => {
      const created = await tx.invite.create({
        data: { workspaceId, email, role: input.role, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 7 * 86400000) },
      });
      await tx.activity.create({
        data: { workspaceId, actorId: response.locals.userId as string, action: "member.invited", subjectId: created.id, metadata: { email, role: input.role } },
      });
      return created;
    });
    const inviteUrl = new URL("/", webOrigin);
    inviteUrl.searchParams.set("invite", token);
    void notifications.add("workspace-invite", { email, workspaceId, role: input.role, inviteUrl: inviteUrl.toString() }).catch(() => undefined);
    void invalidateSummary(workspaceId);
    response.status(202).json({ id: invite.id, email, role: invite.role, expiresAt: invite.expiresAt, inviteUrl: inviteUrl.toString() });
  } catch (error) {
    next(error);
  }
});

app.post("/invites/:token/accept", authenticate, async (request, response, next) => {
  try {
    const token = routeParam(request, "token");
    const userId = response.locals.userId as string;
    const [invite, user] = await Promise.all([
      prisma.invite.findUnique({ where: { tokenHash: tokenHash(token) } }),
      prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    ]);
    if (!invite || invite.acceptedAt || invite.expiresAt <= new Date()) {
      response.status(404).json({ error: "Invitation is invalid or expired" });
      return;
    }
    if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
      response.status(403).json({ error: "Sign in with the email address this invitation was sent to" });
      return;
    }
    const accepted = await prisma.$transaction(async (tx) => {
      const claimed = await tx.invite.updateMany({
        where: { id: invite.id, acceptedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count !== 1) return false;
      await tx.membership.create({ data: { workspaceId: invite.workspaceId, userId, role: invite.role } });
      await tx.activity.create({
        data: { workspaceId: invite.workspaceId, actorId: userId, action: "member.added", subjectId: userId, metadata: { role: invite.role } },
      });
      return true;
    });
    if (!accepted) {
      response.status(409).json({ error: "Invitation was already accepted" });
      return;
    }
    void invalidateSummary(invite.workspaceId);
    response.status(201).json({ workspaceId: invite.workspaceId, role: invite.role });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      response.status(409).json({ error: "You are already a member of this workspace" });
      return;
    }
    next(error);
  }
});

app.patch("/workspaces/:workspaceId/members/:userId", authenticate, requireWorkspacePermission("manageMembers"), async (request, response, next) => {
  try {
    const workspaceId = routeParam(request, "workspaceId");
    const userId = routeParam(request, "userId");
    const input = roleUpdateSchema.parse(request.body);
    const actorRole = response.locals.workspaceRole as WorkspaceRole;
    const target = await prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (!target) {
      response.status(404).json({ error: "Member not found" });
      return;
    }
    if (!canManageMember(actorRole, target.role) || !canAssignRole(actorRole, input.role)) {
      response.status(403).json({ error: "You cannot change this member or assign that role" });
      return;
    }
    if (target.role === input.role) {
      response.json({ userId, role: target.role });
      return;
    }
    const updated = await prisma.$transaction(async (tx) => {
      const member = await tx.membership.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { role: input.role } });
      await tx.activity.create({
        data: { workspaceId, actorId: response.locals.userId as string, action: "member.role_changed", subjectId: userId, metadata: { fromRole: target.role, toRole: input.role } },
      });
      return member;
    });
    response.json({ userId, role: updated.role });
  } catch (error) {
    next(error);
  }
});

app.delete("/workspaces/:workspaceId/members/:userId", authenticate, requireWorkspacePermission("manageMembers"), async (request, response, next) => {
  try {
    const workspaceId = routeParam(request, "workspaceId");
    const userId = routeParam(request, "userId");
    const actorRole = response.locals.workspaceRole as WorkspaceRole;
    const target = await prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: { user: { select: { email: true } } },
    });
    if (!target) {
      response.status(404).json({ error: "Member not found" });
      return;
    }
    if (!canManageMember(actorRole, target.role)) {
      response.status(403).json({ error: "You cannot remove this member" });
      return;
    }
    await prisma.$transaction([
      prisma.activity.create({ data: { workspaceId, actorId: response.locals.userId as string, action: "member.removed", subjectId: userId, metadata: { email: target.user.email, role: target.role } } }),
      prisma.membership.delete({ where: { workspaceId_userId: { workspaceId, userId } } }),
    ]);
    const memberSockets = await io.in(userSocketRoom(userId)).fetchSockets();
    for (const socket of memberSockets) {
      const boardRooms = [...socket.rooms].filter((room) => room.startsWith(`workspace:${workspaceId}:board:`));
      for (const room of boardRooms) await socket.leave(room);
    }
    void invalidateSummary(workspaceId);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/workspaces/:workspaceId/activity", authenticate, requireWorkspacePermission("read"), async (request, response, next) => {
  try {
    const workspaceId = routeParam(request, "workspaceId");
    const cursor = typeof request.query.cursor === "string" ? request.query.cursor : undefined;
    const take = z.coerce.number().int().min(1).max(100).default(30).parse(request.query.take);
    const entries = await prisma.activity.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { actor: { select: { id: true, name: true } } },
    });
    const hasMore = entries.length > take;
    if (hasMore) entries.pop();
    response.json({ items: entries, nextCursor: hasMore ? entries.at(-1)?.id : null });
  } catch (error) {
    next(error);
  }
});

function boardRoom(workspaceId: string, boardId: string): string {
  return `workspace:${workspaceId}:board:${boardId}`;
}

function userSocketRoom(userId: string): string {
  return `user:${userId}`;
}

async function invalidateSummary(workspaceId: string): Promise<void> {
  await cache.del(`workspace-summary:${workspaceId}`).catch(() => undefined);
}

io.use((socket, next) => {
  const token = socket.handshake.auth.token as string | undefined;
  if (!token) return next(new Error("Authentication required"));
  try {
    const claims = jwt.verify(token, accessSecret) as AuthClaims;
    socket.data.userId = claims.sub;
    next();
  } catch {
    next(new Error("Access token is invalid or expired"));
  }
});

io.on("connection", (socket) => {
  void socket.join(userSocketRoom(socket.data.userId as string));
  socket.on("board:join", async (payload: { workspaceId?: string; boardId?: string }, callback?: (result: { ok: boolean; error?: string }) => void) => {
    if (!payload?.workspaceId || !payload.boardId) {
      callback?.({ ok: false, error: "Workspace and board are required" });
      return;
    }
    const membership = await prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId: payload.workspaceId, userId: socket.data.userId as string } },
    }).catch(() => null);
    const board = membership ? await prisma.board.findFirst({ where: { id: payload.boardId, workspaceId: payload.workspaceId } }).catch(() => null) : null;
    if (!board) {
      callback?.({ ok: false, error: "Board not found" });
      return;
    }
    await socket.join(boardRoom(payload.workspaceId, payload.boardId));
    callback?.({ ok: true });
  });
});

const worker = new Worker(
  "workspace-notifications",
  async (job) => {
    if (job.name === "workspace-invite") {
      if (!emailTransport) {
        console.info("Workspace invite queued without SMTP transport", { workspaceId: job.data.workspaceId, role: job.data.role });
        return;
      }
      await emailTransport.sendMail({
        from: process.env.SMTP_FROM ?? "Commonplace <no-reply@example.com>",
        to: job.data.email,
        subject: "You have been invited to a Commonplace workspace",
        text: `You have been invited to collaborate. Accept your invitation: ${job.data.inviteUrl}`,
        html: `<p>You have been invited to collaborate.</p><p><a href="${job.data.inviteUrl}">Accept your invitation</a></p>`,
      });
      return;
    }
    console.info("Workspace task notification processed", { name: job.name, workspaceId: job.data.workspaceId });
  },
  { connection: new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true }) },
);
worker.on("error", () => undefined);

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
        if (response.headersSent) {
          _next(error);
          return;
        }
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: "Invalid request", issues: error.issues.map(({ path, message }) => ({ path, message })) });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

const port = Number(process.env.PORT ?? 4000);
httpServer.listen(port, () => console.info(`Workspace API listening on ${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    const forceExit = setTimeout(() => process.exit(1), 8000);
    forceExit.unref();
    void Promise.allSettled([
      worker.close(),
      notifications.close(),
      cache.quit(),
      queueConnection.quit(),
    ])
      .then(() => new Promise<void>((resolve) => io.close(() => resolve())))
      .then(() => prisma.$disconnect())
      .finally(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
  });
}
