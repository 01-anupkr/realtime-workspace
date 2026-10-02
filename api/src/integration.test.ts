import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

const enabled = process.env.RUN_INTEGRATION_TESTS === "true";
const suite = enabled ? describe : describe.skip;
const port = Number(process.env.TEST_API_PORT ?? 4111);
const baseUrl = `http://127.0.0.1:${port}`;
let apiProcess: ChildProcess | undefined;

suite("HTTP integration against PostgreSQL", () => {
  beforeAll(async () => {
    apiProcess = spawn(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "test", PORT: String(port) },
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (apiProcess.exitCode !== null) throw new Error("API exited before becoming healthy");
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error("API did not become healthy in time");
  }, 30000);

  afterAll(async () => {
    apiProcess?.kill("SIGTERM");
    if (apiProcess && apiProcess.exitCode === null) {
      await new Promise<void>((resolve) => apiProcess?.once("exit", () => resolve()));
    }
  }, 10000);

  it("signs up, rotates refresh tokens, and rejects token reuse", async () => {
    const agent = request.agent(baseUrl);
    const signup = await agent.post("/auth/signup").send({
      name: "Integration Owner",
      email: `owner-${Date.now()}@example.test`,
      password: "correct-horse-battery-staple",
      workspaceName: "Integration Workspace",
    });
    expect(signup.status).toBe(201);
    expect(signup.body.accessToken).toBeTypeOf("string");
    const cookieHeader = signup.headers["set-cookie"];
    const firstCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    if (!firstCookie) throw new Error("Signup did not set a refresh cookie");
    const originalCookie = firstCookie.split(";")[0];

    const refreshed = await agent.post("/auth/refresh");
    expect(refreshed.status).toBe(200);
    const rotatedHeader = refreshed.headers["set-cookie"];
    const rotatedCookie = Array.isArray(rotatedHeader) ? rotatedHeader[0] : rotatedHeader;
    if (!rotatedCookie) throw new Error("Refresh did not rotate the session cookie");
    expect(rotatedCookie.split(";")[0]).not.toBe(originalCookie);

    const replay = await request(baseUrl).post("/auth/refresh").set("Cookie", originalCookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toContain("reuse detected");
  });

  it("scopes task mutations to workspace membership and rejects stale versions", async () => {
    const owner = await request(baseUrl).post("/auth/signup").send({
      name: "Board Owner",
      email: `board-owner-${Date.now()}@example.test`,
      password: "correct-horse-battery-staple",
      workspaceName: "Private Workspace",
    });
    const outsider = await request(baseUrl).post("/auth/signup").send({
      name: "Outside User",
      email: `outside-${Date.now()}@example.test`,
      password: "correct-horse-battery-staple",
      workspaceName: "Other Workspace",
    });
    const token = owner.body.accessToken as string;
    const outsiderToken = outsider.body.accessToken as string;
    const boardPath = `/workspaces/${owner.body.workspaceId}/boards/${owner.body.boardId}`;
    const board = await request(baseUrl).get(boardPath).set("Authorization", `Bearer ${token}`);
    expect(board.status).toBe(200);
    const listId = board.body.lists[0].id as string;
    const reorderedList = await request(baseUrl)
      .patch(`/workspaces/${owner.body.workspaceId}/boards/${owner.body.boardId}/lists/${board.body.lists[2].id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ version: 1, previousId: null, nextId: listId });
    expect(reorderedList.status).toBe(200);
    expect(reorderedList.body.version).toBe(2);
    const staleList = await request(baseUrl)
      .patch(`/workspaces/${owner.body.workspaceId}/boards/${owner.body.boardId}/lists/${board.body.lists[2].id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ version: 1, title: "Stale list edit" });
    expect(staleList.status).toBe(409);
    const createdList = await request(baseUrl)
      .post(`/workspaces/${owner.body.workspaceId}/boards/${owner.body.boardId}/lists`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Later" });
    expect(createdList.status).toBe(201);

    const created = await request(baseUrl)
      .post(`${boardPath}/tasks`)
      .set("Authorization", `Bearer ${token}`)
      .send({ listId, title: "Verify task endpoint" });
    expect(created.status).toBe(201);

    const taskPath = `/workspaces/${owner.body.workspaceId}/boards/${owner.body.boardId}/tasks/${created.body.id}`;
    const updated = await request(baseUrl).patch(taskPath).set("Authorization", `Bearer ${token}`).send({ version: 1, title: "Updated task" });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);

    const stale = await request(baseUrl).patch(taskPath).set("Authorization", `Bearer ${token}`).send({ version: 1, title: "Stale edit" });
    expect(stale.status).toBe(409);

    const leaked = await request(baseUrl).get(boardPath).set("Authorization", `Bearer ${outsiderToken}`);
    expect(leaked.status).toBe(404);
  });

  it("accepts emailed invites and enforces Viewer and Owner role boundaries", async () => {
    const owner = await request(baseUrl).post("/auth/signup").send({
      name: "Invite Owner",
      email: `invite-owner-${Date.now()}@example.test`,
      password: "correct-horse-battery-staple",
      workspaceName: "Invite Workspace",
    });
    const ownerToken = owner.body.accessToken as string;
    const inviteEmail = `viewer-${Date.now()}@example.test`;
    const invite = await request(baseUrl)
      .post(`/workspaces/${owner.body.workspaceId}/invites`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: inviteEmail, role: "VIEWER" });
    expect(invite.status).toBe(202);
    const inviteToken = new URL(invite.body.inviteUrl as string).searchParams.get("invite");
    expect(inviteToken).toBeTruthy();

    const member = await request(baseUrl).post("/auth/signup").send({
      name: "Invited Viewer",
      email: inviteEmail,
      password: "correct-horse-battery-staple",
      inviteToken,
    });
    expect(member.status).toBe(201);
    expect(member.body.workspaceId).toBe(owner.body.workspaceId);

    const boardPath = `/workspaces/${owner.body.workspaceId}/boards/${owner.body.boardId}`;
    const board = await request(baseUrl).get(boardPath).set("Authorization", `Bearer ${ownerToken}`);
    const forbidden = await request(baseUrl)
      .post(`${boardPath}/tasks`)
      .set("Authorization", `Bearer ${member.body.accessToken}`)
      .send({ listId: board.body.lists[0].id, title: "Viewer cannot write" });
    expect(forbidden.status).toBe(403);

    const roleChange = await request(baseUrl)
      .patch(`/workspaces/${owner.body.workspaceId}/members/${member.body.user.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ role: "MEMBER" });
    expect(roleChange.status).toBe(200);

    const removed = await request(baseUrl)
      .delete(`/workspaces/${owner.body.workspaceId}/members/${member.body.user.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(removed.status).toBe(204);

    const members = await request(baseUrl)
      .get(`/workspaces/${owner.body.workspaceId}/members`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(members.body).toHaveLength(1);
  });
});
