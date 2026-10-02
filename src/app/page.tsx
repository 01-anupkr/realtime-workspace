"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  Activity, Check, ChevronLeft, ChevronRight, CircleHelp, Clipboard, Columns3,
  Filter, LayoutGrid, LoaderCircle, LogOut, Plus, Search, Sparkles, Wifi, WifiOff, X,
} from "lucide-react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "https://api-production-4d566.up.railway.app";

type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE";
type Task = {
  id: string;
  listId: string;
  title: string;
  description: string;
  status: TaskStatus;
  label: string | null;
  assigneeId: string | null;
  version: number;
  rank: string;
};
type List = { id: string; title: string; rank: string; version: number; tasks: Task[] };
type Board = { id: string; name: string; lists: List[] };
type Workspace = { id: string; name: string; role: string };
type User = { id: string; name: string; email: string };
type Member = User & { role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER"; joinedAt: string };

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function mergeTask(board: Board | null, task: Task): Board | null {
  if (!board) return board;
  return {
    ...board,
    lists: board.lists.map((list) => {
      const withoutTask = list.tasks.filter((item) => item.id !== task.id);
      if (list.id !== task.listId) return { ...list, tasks: withoutTask };
      return { ...list, tasks: [...withoutTask, task].sort((a, b) => a.rank.localeCompare(b.rank)) };
    }),
  };
}

function mergeList(board: Board | null, list: List): Board | null {
  if (!board) return board;
  return {
    ...board,
    lists: [...board.lists.filter((item) => item.id !== list.id), list].sort((a, b) => a.rank.localeCompare(b.rank)),
  };
}

export default function Home() {
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([]);
  const [boardId, setBoardId] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [activeListId, setActiveListId] = useState("");
  const listNodes = useRef(new Map<string, HTMLElement>());
  const [online, setOnline] = useState(false);
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterLabel, setFilterLabel] = useState("");
  const [searchIds, setSearchIds] = useState<string[] | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [workspaceCreateOpen, setWorkspaceCreateOpen] = useState(false);
  const [workspaceCreatedOpen, setWorkspaceCreatedOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [pendingInviteToken, setPendingInviteToken] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [activityItems, setActivityItems] = useState<{ id: string; action: string; createdAt: string; actor: { name: string } }[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [newTaskList, setNewTaskList] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newListFormOpen, setNewListFormOpen] = useState(false);
  const [newListTitle, setNewListTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`${apiUrl}/auth/refresh`, { method: "POST", credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { accessToken: string };
        if (active) setToken(data.accessToken);
      })
      .catch(() => undefined)
      .finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const invite = new URLSearchParams(window.location.search).get("invite");
    if (!invite) return;
    const timeout = window.setTimeout(() => setPendingInviteToken(invite), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!token || !pendingInviteToken || !user) return;
    let active = true;
    request<{ workspaceId: string }>(`/invites/${encodeURIComponent(pendingInviteToken)}/accept`, token, { method: "POST" })
      .then(async ({ workspaceId: joinedWorkspaceId }) => {
        if (!active) return;
        const items = await request<Workspace[]>("/workspaces", token);
        setWorkspaces(items);
        setWorkspaceId(joinedWorkspaceId);
        setPendingInviteToken("");
        window.history.replaceState(null, "", window.location.pathname);
      })
      .catch((reason: Error) => setError(reason.message));
    return () => { active = false; };
  }, [pendingInviteToken, token, user]);

  useEffect(() => {
    const taskId = selectedTask?.id;
    if (!token || !workspaceId || (!membersOpen && !filtersOpen && !taskId)) return;
    let active = true;
    request<Member[]>(`/workspaces/${workspaceId}/members`, token)
      .then((items) => { if (active) setMembers(items); })
      .catch((reason: Error) => setError(reason.message));
    return () => { active = false; };
  }, [filtersOpen, membersOpen, selectedTask?.id, token, workspaceId]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    Promise.all([request<Workspace[]>("/workspaces", token), request<User>("/auth/me", token)])
      .then(([items, profile]) => {
        if (!active) return;
        setWorkspaces(items);
        setUser(profile);
        setWorkspaceId((current) => current || items[0]?.id || "");
      })
      .catch((reason: Error) => setError(reason.message));
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    if (!token || !workspaceId) return;
    let active = true;
    request<{ id: string; name: string }[]>(`/workspaces/${workspaceId}/boards`, token)
      .then((items) => {
        if (!active) return;
        setBoards(items);
        setBoardId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? "");
        if (!items.length) setError("This workspace has no boards yet");
      })
      .catch((reason: Error) => setError(reason.message));
    return () => { active = false; };
  }, [token, workspaceId]);

  useEffect(() => {
    if (!token || !workspaceId || !boardId) return;
    let active = true;
    request<Board>(`/workspaces/${workspaceId}/boards/${boardId}`, token)
      .then((loaded) => { if (active) setBoard(loaded); })
      .catch((reason: Error) => setError(reason.message));
    return () => { active = false; };
  }, [token, workspaceId, boardId]);

  useEffect(() => {
    if (!token) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      return;
    }

    if (!socketRef.current) {
      const socket = io(apiUrl, { auth: { token }, reconnection: true, withCredentials: true });
      socketRef.current = socket;
      socket.on("connect", () => setOnline(true));
      socket.on("disconnect", () => setOnline(false));
      socket.on("task:created", (task: Task) => setBoard((current) => mergeTask(current, task)));
      socket.on("task:updated", (task: Task) => setBoard((current) => mergeTask(current, task)));
      socket.on("list:created", (list: List) => setBoard((current) => mergeList(current, list)));
      socket.on("list:updated", (list: List) => setBoard((current) => mergeList(current, list)));
      socket.on("task:deleted", ({ id }: { id: string }) => setBoard((current) => current ? ({
        ...current, lists: current.lists.map((list) => ({ ...list, tasks: list.tasks.filter((task) => task.id !== id) })),
      }) : current));
    }
  }, [token]);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!token || !workspaceId || !board?.id) return;
    const socket = socketRef.current;
    if (!socket) return;

    const joinBoard = () => {
      socket.emit("board:join", { workspaceId, boardId: board.id }, (result?: { ok?: boolean; error?: string }) => {
        if (result && !result.ok) {
          setError(result.error ?? "Could not join the board");
        }
      });
    };

    if (socket.connected) {
      joinBoard();
    } else {
      socket.once("connect", joinBoard);
    }

    return () => {
      socket.emit("board:leave", { workspaceId, boardId: board.id });
    };
  }, [board?.id, token, workspaceId]);

  useEffect(() => {
    const hasFilters = Boolean(query.trim() || filterStatus || filterAssignee || filterLabel);
    if (!token || !workspaceId || !hasFilters) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ page: "1", pageSize: "50" });
      if (query.trim()) params.set("q", query.trim());
      if (filterStatus) params.set("status", filterStatus);
      if (filterAssignee) params.set("assigneeId", filterAssignee);
      if (filterLabel.trim()) params.set("label", filterLabel.trim());
      request<{ items: Task[] }>(`/workspaces/${workspaceId}/search?${params}`, token, { signal: controller.signal })
        .then(({ items }) => setSearchIds(items.map((task) => task.id)))
        .catch((reason: Error) => { if (reason.name !== "AbortError") setError(reason.message); });
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [filterAssignee, filterLabel, filterStatus, query, token, workspaceId]);

  useEffect(() => {
    if (!token || !workspaceId || !activityOpen) return;
    request<{ items: typeof activityItems }>(`/workspaces/${workspaceId}/activity?take=30`, token)
      .then(({ items }) => setActivityItems(items))
      .catch((reason: Error) => setError(reason.message));
  }, [activityOpen, token, workspaceId]);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      const response = await fetch(`${apiUrl}/auth/${mode}`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not sign in");
      if (mode === "signup" && pendingInviteToken) {
        setPendingInviteToken("");
        window.history.replaceState(null, "", window.location.pathname);
      }
      setToken(result.accessToken);
      setUser(result.user);
      if (result.workspaceId) setWorkspaceId(result.workspaceId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const invite = await request<{ inviteUrl: string }>(`/workspaces/${workspaceId}/invites`, token, {
        method: "POST", body: JSON.stringify({ email: form.get("email"), role: form.get("role") }),
      });
      setInviteUrl(invite.inviteUrl);
      formElement.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invitation could not be created");
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = new FormData(event.currentTarget);
    try {
      const created = await request<{ workspaceId: string; boardId: string; workspace: Workspace }>("/workspaces", token, {
        method: "POST",
        body: JSON.stringify({ name: form.get("name") }),
      });
      setWorkspaces((current) => [...current, created.workspace]);
      setWorkspaceId(created.workspaceId);
      setBoardId(created.boardId);
      setBoard(null);
      setWorkspaceCreateOpen(false);
      setWorkspaceCreatedOpen(true);
      event.currentTarget.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Workspace could not be created");
    }
  }

  async function changeMemberRole(member: Member, role: Member["role"]) {
    if (!token) return;
    try {
      await request(`/workspaces/${workspaceId}/members/${member.id}`, token, { method: "PATCH", body: JSON.stringify({ role }) });
      setMembers((current) => current.map((item) => item.id === member.id ? { ...item, role } : item));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Role could not be changed");
    }
  }

  async function removeMember(member: Member) {
    if (!token || !window.confirm(`Remove ${member.name} from this workspace?`)) return;
    try {
      await request<void>(`/workspaces/${workspaceId}/members/${member.id}`, token, { method: "DELETE" });
      setMembers((current) => current.filter((item) => item.id !== member.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Member could not be removed");
    }
  }

  async function createTask(list: List) {
    if (!token || !board || !newTaskTitle.trim()) return;
    try {
      const task = await request<Task>(`/workspaces/${workspaceId}/boards/${board.id}/tasks`, token, {
        method: "POST", body: JSON.stringify({ listId: list.id, title: newTaskTitle.trim() }),
      });
      setBoard((current) => mergeTask(current, task));
      setNewTaskTitle("");
      setNewTaskList("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Task could not be created");
    }
  }

  async function createList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !board || !newListTitle.trim()) return;
    try {
      const list = await request<List>(`/workspaces/${workspaceId}/boards/${board.id}/lists`, token, {
        method: "POST", body: JSON.stringify({ title: newListTitle.trim() }),
      });
      setBoard((current) => mergeList(current, list));
      setNewListTitle("");
      setNewListFormOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "List could not be created");
    }
  }

  async function moveList(list: List, beforeListId: string | null) {
    if (!token || !board || list.id === beforeListId) return;
    const siblings = board.lists.filter((item) => item.id !== list.id);
    const nextIndex = beforeListId ? siblings.findIndex((item) => item.id === beforeListId) : -1;
    if (beforeListId && nextIndex < 0) return;
    const previous = nextIndex >= 0 ? siblings[nextIndex - 1] : siblings.at(-1);
    const next = nextIndex >= 0 ? siblings[nextIndex] : undefined;
    try {
      const updated = await request<List>(`/workspaces/${workspaceId}/boards/${board.id}/lists/${list.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ version: list.version, previousId: previous?.id ?? null, nextId: next?.id ?? null }),
      });
      setBoard((current) => mergeList(current, updated));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "List move failed");
    }
  }

  async function moveTask(task: Task, list: List, beforeTaskId?: string) {
    if (!token || !board) return;
    const tasks = list.tasks.filter((item) => item.id !== task.id);
    const nextIndex = beforeTaskId ? tasks.findIndex((item) => item.id === beforeTaskId) : -1;
    const previous = nextIndex >= 0 ? tasks[nextIndex - 1] : tasks.at(-1);
    const next = nextIndex >= 0 ? tasks[nextIndex] : undefined;
    try {
      const updated = await request<Task>(`/workspaces/${workspaceId}/boards/${board.id}/tasks/${task.id}`, token, {
        method: "PATCH", body: JSON.stringify({ version: task.version, listId: list.id, previousId: previous?.id ?? null, nextId: next?.id ?? null }),
      });
      setBoard((current) => mergeTask(current, updated));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Task move failed");
    }
  }

  async function saveTask(task: Task, title: string, description: string, status: TaskStatus, label: string, assigneeId: string) {
    if (!token || !board) return;
    try {
      const updated = await request<Task>(`/workspaces/${workspaceId}/boards/${board.id}/tasks/${task.id}`, token, {
        method: "PATCH", body: JSON.stringify({ version: task.version, title, description, status, label: label.trim() || null, assigneeId: assigneeId || null }),
      });
      setBoard((current) => mergeTask(current, updated));
      setSelectedTask(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Task could not be saved");
    }
  }

  async function deleteTask(task: Task) {
    if (!token || !board) return;
    try {
      await request<void>(`/workspaces/${workspaceId}/boards/${board.id}/tasks/${task.id}`, token, { method: "DELETE" });
      setBoard((current) => current ? ({ ...current, lists: current.lists.map((list) => ({ ...list, tasks: list.tasks.filter((item) => item.id !== task.id) })) }) : current);
      setSelectedTask(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Task could not be deleted");
    }
  }

  async function signOut() {
    if (token) await fetch(`${apiUrl}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => undefined);
    setToken(null);
    setUser(null);
    setBoard(null);
    setWorkspaces([]);
    setBoards([]);
    setBoardId("");
    setWorkspaceId("");
  }

  function focusList(listId: string) {
    setActiveListId(listId);
    requestAnimationFrame(() => listNodes.current.get(listId)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" }));
  }

  if (!ready) return <main className="boot-screen"><LoaderCircle className="spin" size={22} /><span>Connecting to your workspace</span></main>;

  if (!token) return (
    <main className="auth-shell">
      <section className="auth-rail">
        <div className="brand-lockup"><span className="brand-mark"><Columns3 size={19} /></span><span>Commonplace</span></div>
        <div className="auth-copy">
          <p className="eyebrow">A shared place to make progress</p>
          <h1>Good work moves<br />better together.</h1>
          <p>Plan clearly, work in the open, and keep every team in sync.</p>
        </div>
        <div className="auth-art" aria-hidden="true"><div className="art-top"><span></span><span></span><span></span></div><div className="art-grid"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><div className="art-task"><b></b><span></span><em></em></div><div className="art-task short"><b></b><span></span><em></em></div></div>
        <span className="rail-note">Independent work, connected teams.</span>
      </section>
      <section className="auth-main">
        <div className="auth-top"><span>WORKSPACE ACCESS</span><button type="button" className="quiet-button"><CircleHelp size={17} /></button></div>
        <form className="auth-form" onSubmit={authenticate}>
          <span className="form-mark">{mode === "signup" ? "01 / START HERE" : "WELCOME BACK"}</span>
          <h2>{pendingInviteToken && mode === "signup" ? "Join your team" : mode === "signup" ? "Create your workspace" : "Sign in to continue"}</h2>
          <p className="muted">{pendingInviteToken ? "Create an account with the invited email to join this workspace." : mode === "signup" ? "Your team can join you once you're in." : "Pick up where your team left off."}</p>
          {pendingInviteToken && mode === "signup" && <input type="hidden" name="inviteToken" value={pendingInviteToken} />}
          {mode === "signup" && <label>Your name<input name="name" autoComplete="name" placeholder="Alex Morgan" required /></label>}
          <label>Work email<input name="email" type="email" autoComplete="email" placeholder="you@company.com" required /></label>
          <label>Password<input name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={mode === "signup" ? 12 : 1} placeholder={mode === "signup" ? "At least 12 characters" : "Your password"} required /></label>
          {mode === "signup" && !pendingInviteToken && <label>Workspace name<input name="workspaceName" placeholder="Northstar Studio" required /></label>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button auth-submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : null}{mode === "signup" ? "Create workspace" : "Sign in"}<span>↗</span></button>
          <p className="auth-switch">{mode === "signup" ? "Already working here?" : "New to Commonplace?"} <button type="button" onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setError(""); }}>{mode === "signup" ? "Sign in" : "Create an account"}</button></p>
        </form>
        <span className="auth-legal">Private by default <i></i> Built for teams</span>
      </section>
    </main>
  );

  const visibleTasks = (list: List) => list.tasks.filter((task) => searchIds === null || searchIds.includes(task.id));
  const listCount = board?.lists.length ?? 0;
  const labels = Array.from(new Set((board?.lists ?? []).flatMap((list) => list.tasks.map((task) => task.label).filter((label): label is string => Boolean(label)))));
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><span className="brand-mark"><Columns3 size={17} /></span><span>Commonplace</span></div>
        <button className="workspace-switch" onClick={() => setWorkspaceCreateOpen(true)} title="Create a workspace"><span className="workspace-avatar">{(workspaces.find((item) => item.id === workspaceId)?.name ?? "W").slice(0, 1).toUpperCase()}</span><span className="workspace-name">{workspaces.find((item) => item.id === workspaceId)?.name ?? "Workspace"}<small>{workspaces.find((item) => item.id === workspaceId)?.role ?? "Workspace"}</small></span><Plus size={15} /></button>
        <div className="main-nav"><div className="nav-item active"><LayoutGrid size={17} /> Boards <span>{boards.length}</span></div></div>
        <div className="side-section"><div className="section-heading"><span>YOUR BOARDS</span></div>{boards.map((item, index) => <button key={item.id} className={`side-link ${item.id === boardId ? "selected" : ""}`} onClick={() => setBoardId(item.id)}><span className={`side-square ${["green", "coral", "blue"][index % 3]}`}></span>{item.name}</button>)}</div>
        <div className="side-section list-nav-section"><div className="section-heading"><span>BOARD LISTS</span></div>{(board?.lists ?? []).map((list, index) => <button key={list.id} className={`side-link list-nav-link ${activeListId === list.id ? "selected" : ""}`} aria-current={activeListId === list.id ? "location" : undefined} onClick={() => focusList(list.id)}><span className={`side-square ${["green", "coral", "blue"][index % 3]}`}></span><span className="list-nav-title">{list.title}</span><span className="list-nav-count">{list.tasks.length}</span></button>)}</div>
        <div className="sidebar-spacer" />
        <button className="profile-row" onClick={signOut}><span className="profile-avatar">{user?.name.slice(0, 1).toUpperCase() ?? "A"}</span><span className="profile-meta">{user?.name ?? "Account"}<small>{user?.email ?? ""}</small></span><LogOut size={15} /></button>
      </aside>
      <section className="main-panel">
        <header className="topbar"><div className="breadcrumbs"><span>{workspaces.find((item) => item.id === workspaceId)?.name ?? "Workspace"}</span><span>/</span><strong>{board?.name ?? "Board"}</strong></div><div className="top-actions"><div className={`live-status ${online ? "is-live" : ""}`}><span>{online ? <Wifi size={14} /> : <WifiOff size={14} />}</span>{online ? "Live" : "Reconnecting"}</div><span className="mini-avatar">{user?.name.slice(0, 1).toUpperCase() ?? "A"}</span></div></header>
        <div className="board-area">
          <div className="board-heading"><div><div className="heading-kicker"><span className="tiny-board-mark"></span> TEAM BOARD</div><h1>{board?.name ?? "Loading board"}</h1><p>Shared space for the work that moves us forward.</p></div><div className="heading-actions"><span className="role-chip">{workspaces.find((item) => item.id === workspaceId)?.role ?? ""}</span>{["OWNER", "ADMIN"].includes(workspaces.find((item) => item.id === workspaceId)?.role ?? "") && <button className="invite-button" onClick={() => { setMembersOpen(true); setInviteUrl(""); }}><Plus size={15} /> Manage members</button>}</div></div>
          <div className="board-toolbar"><div className="toolbar-left"><div className="view-tabs"><span className="view-tab active"><Columns3 size={15} /> Board</span></div><span className="toolbar-divider"></span><label className="search-box"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setSearchIds(null); }} placeholder="Search tasks" /><kbd>⌘ K</kbd></label><button className={`filter-button ${filtersOpen ? "filter-active" : ""}`} onClick={() => setFiltersOpen(!filtersOpen)}><Filter size={15} /><span>Filter</span></button></div><div className="toolbar-right"><button className="toolbar-action" onClick={() => setActivityOpen(!activityOpen)}><Activity size={15} /> Activity</button></div></div>
          {filtersOpen && <div className="filter-popover"><label>Status<select value={filterStatus} onChange={(event) => { setFilterStatus(event.target.value); setSearchIds(null); }}><option value="">Any status</option><option value="TODO">To do</option><option value="IN_PROGRESS">In progress</option><option value="DONE">Done</option></select></label><label>Assignee<select value={filterAssignee} onChange={(event) => { setFilterAssignee(event.target.value); setSearchIds(null); }}><option value="">Anyone</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><label>Label<select value={filterLabel} onChange={(event) => { setFilterLabel(event.target.value); setSearchIds(null); }}><option value="">Any label</option>{labels.map((label) => <option key={label} value={label}>{label}</option>)}</select></label><button className="clear-filters" onClick={() => { setFilterStatus(""); setFilterAssignee(""); setFilterLabel(""); setQuery(""); setSearchIds(null); }}>Clear filters</button></div>}
          {error && <div className="toast-error" role="status"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss"><X size={15} /></button></div>}
          <div className="board-scroll"><div className="board-columns">
            {(board?.lists ?? []).map((list, columnIndex) => (
              <section ref={(element) => { if (element) listNodes.current.set(list.id, element); else listNodes.current.delete(list.id); }} className={`board-column column-${columnIndex % 3} ${activeListId === list.id ? "is-list-focused" : ""}`} key={list.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const payload = event.dataTransfer.getData("text/plain"); if (payload.startsWith("list:")) { const draggedList = board?.lists.find((item) => item.id === payload.slice(5)); if (draggedList) void moveList(draggedList, list.id); return; } const task = board?.lists.flatMap((item) => item.tasks).find((item) => item.id === payload); if (task) void moveTask(task, list); }}>
                <div className="column-heading" draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", `list:${list.id}`); }}><span className="column-indicator"></span><h2>{list.title}</h2><span className="task-count">{visibleTasks(list).length}</span><div className="list-order-controls"><button className="icon-button" title="Move list left" aria-label={`Move ${list.title} left`} disabled={columnIndex === 0} onClick={() => { const target = board?.lists[columnIndex - 1]; if (target) void moveList(list, target.id); }}><ChevronLeft size={14} /></button><button className="icon-button" title="Move list right" aria-label={`Move ${list.title} right`} disabled={columnIndex === listCount - 1} onClick={() => { const target = board?.lists[columnIndex + 2]; void moveList(list, target?.id ?? null); }}><ChevronRight size={14} /></button></div></div>
                <div className="task-stack">
                  {visibleTasks(list).map((task, taskIndex) => (
                    <article key={task.id} className="task-card" draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", task.id)} onDrop={(event) => { const payload = event.dataTransfer.getData("text/plain"); if (payload.startsWith("list:")) return; event.preventDefault(); event.stopPropagation(); const dragged = board?.lists.flatMap((item) => item.tasks).find((item) => item.id === payload); if (dragged && dragged.id !== task.id) void moveTask(dragged, list, task.id); }} onDragOver={(event) => event.preventDefault()}>
                      <button className="task-open" onClick={() => setSelectedTask(task)}><span className={`task-check status-${task.status.toLowerCase()}`}>{task.status === "DONE" ? <Check size={12} /> : null}</span><span className="task-title">{task.title}</span></button>
                      {task.description && <p className="task-description">{task.description}</p>}
                      <div className="task-foot"><span className={`label-pill ${task.label ? "label-custom" : "label-default"}`}>{task.label ?? (task.status === "IN_PROGRESS" ? "In progress" : task.status === "DONE" ? "Complete" : "Planned")}</span><span className="task-foot-spacer" /><span className="task-assignee">{members.find((member) => member.id === task.assigneeId)?.name.slice(0, 2).toUpperCase() ?? ""}</span></div>
                      {taskIndex === 0 && columnIndex === 0 && <span className="card-accent"></span>}
                    </article>
                  ))}
                  {newTaskList === list.id ? <form className="new-task-form" onSubmit={(event) => { event.preventDefault(); void createTask(list); }}><input autoFocus value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} placeholder="Task title" onKeyDown={(event) => { if (event.key === "Escape") setNewTaskList(""); }} /><button type="submit" title="Create task"><Check size={15} /></button></form> : <button className="add-task" onClick={() => setNewTaskList(list.id)}><Plus size={16} /> Add task</button>}
                </div>
              </section>
            ))}
            {newListFormOpen ? <form className="new-task-form new-list-form" onSubmit={createList}><input autoFocus value={newListTitle} onChange={(event) => setNewListTitle(event.target.value)} placeholder="List name" onKeyDown={(event) => { if (event.key === "Escape") setNewListFormOpen(false); }} /><button type="submit" title="Create list"><Check size={15} /></button></form> : <button className="add-column" onClick={() => setNewListFormOpen(true)}><Plus size={16} /> Add a list</button>}
          </div></div>
          <footer className="board-footer"><span><Sparkles size={14} /> You’re all caught up</span><span>Updated just now</span></footer>
        </div>
      </section>
      {activityOpen && <aside className="activity-panel"><div className="panel-heading"><div><span className="panel-kicker">WORKSPACE</span><h2>Activity</h2></div><button className="icon-button" onClick={() => setActivityOpen(false)} aria-label="Close activity"><X size={18} /></button></div><div className="activity-list">{activityItems.map((item) => <div className="activity-item" key={item.id}><span className="activity-avatar">{item.actor.name.slice(0, 1)}</span><p><b>{item.actor.name}</b> {item.action.replace("task.", "task ").replaceAll(".", " ")}<small>{new Date(item.createdAt).toLocaleString()}</small></p></div>)}{activityItems.length === 0 && <p className="empty-state">No activity yet.</p>}</div></aside>}
      {membersOpen && <MembersDialog members={members} actorRole={workspaces.find((item) => item.id === workspaceId)?.role ?? "VIEWER"} currentUserId={user?.id ?? ""} inviteUrl={inviteUrl} onClose={() => setMembersOpen(false)} onInvite={inviteMember} onRoleChange={changeMemberRole} onRemove={removeMember} />}
      {workspaceCreateOpen && <WorkspaceCreateDialog onClose={() => setWorkspaceCreateOpen(false)} onCreate={createWorkspace} />}
      {workspaceCreatedOpen && <WorkspaceCreatedDialog workspaceName={workspaces.find((item) => item.id === workspaceId)?.name ?? "Workspace"} online={online} onClose={() => setWorkspaceCreatedOpen(false)} />}
      {selectedTask && <TaskDialog task={selectedTask} members={members} onClose={() => setSelectedTask(null)} onSave={saveTask} onDelete={deleteTask} />}
    </main>
  );
}

function WorkspaceCreateDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="workspace-dialog"><header><div><span className="dialog-kicker">WORKSPACE SETUP</span><h2>Create a workspace</h2><p>Give your team a focused home for projects, decisions, and momentum.</p></div><button className="icon-button" onClick={onClose} aria-label="Close workspace creation"><X size={18} /></button></header><form onSubmit={onCreate}><label>Workspace name<input name="name" autoFocus placeholder="Northstar Studio" required maxLength={80} /></label><div className="workspace-dialog-grid"><span><b>Private by default</b><small>Only invited members can access it.</small></span><span><b>Ready for live work</b><small>A board and ordered lists are created automatically.</small></span></div><footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button"><Plus size={15} /> Create workspace</button></footer></form></section></div>;
}

function WorkspaceCreatedDialog({ workspaceName, online, onClose }: { workspaceName: string; online: boolean; onClose: () => void }) {
  return <div className="modal-backdrop"><section className="workspace-dialog simulation-dialog"><div className="simulation-orbit"><span></span><span></span><span></span><i><Wifi size={18} /></i></div><span className="dialog-kicker">REAL-TIME SIMULATION</span><h2>{workspaceName} is ready.</h2><p>Your workspace is connected to the live collaboration channel. Changes made by teammates will appear here instantly.</p><div className="simulation-events"><span><b className="event-dot green"></b><strong>Workspace channel</strong><em>Connected</em></span><span><b className="event-dot coral"></b><strong>Board events</strong><em>Listening</em></span><span><b className="event-dot blue"></b><strong>Presence sync</strong><em>{online ? "Live now" : "Connecting"}</em></span></div><button className="primary-button simulation-continue" onClick={onClose}>Open workspace <ChevronRight size={16} /></button></section></div>;
}

function MembersDialog({ members, actorRole, currentUserId, inviteUrl, onClose, onInvite, onRoleChange, onRemove }: {
  members: Member[];
  actorRole: string;
  currentUserId: string;
  inviteUrl: string;
  onClose: () => void;
  onInvite: (event: FormEvent<HTMLFormElement>) => void;
  onRoleChange: (member: Member, role: Member["role"]) => void;
  onRemove: (member: Member) => void;
}) {
  const [copied, setCopied] = useState(false);
  const isOwner = actorRole === "OWNER";
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="members-dialog"><header><div><span className="dialog-kicker">WORKSPACE ACCESS</span><h2>Members</h2></div><button className="icon-button" onClick={onClose} aria-label="Close members"><X size={18} /></button></header><form className="invite-form" onSubmit={onInvite}><label>Email address<input type="email" name="email" placeholder="teammate@company.com" required /></label><label>Role<select name="role" defaultValue="MEMBER"><option value="MEMBER">Member</option><option value="VIEWER">Viewer</option>{isOwner && <option value="ADMIN">Admin</option>}</select></label><button className="primary-button" type="submit"><Plus size={14} /> Create invite</button></form>{inviteUrl && <div className="invite-link"><div><small>INVITATION LINK · EXPIRES IN 7 DAYS</small><input readOnly value={inviteUrl} aria-label="Invitation link" /></div><button className="icon-button bordered" onClick={() => { void navigator.clipboard.writeText(inviteUrl).then(() => setCopied(true)); }} title="Copy invitation link">{copied ? <Check size={16} /> : <Clipboard size={16} />}</button></div>}<div className="member-list-heading"><span>PEOPLE WITH ACCESS</span><span>{members.length}</span></div><div className="member-list">{members.map((member) => { const canManage = actorRole === "OWNER" ? member.role !== "OWNER" : actorRole === "ADMIN" && (member.role === "MEMBER" || member.role === "VIEWER"); return <div className="member-row" key={member.id}><span className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</span><span className="member-details"><b>{member.name}{member.id === currentUserId ? " (you)" : ""}</b><small>{member.email}</small></span>{canManage ? <select aria-label={`Role for ${member.name}`} value={member.role} onChange={(event) => onRoleChange(member, event.target.value as Member["role"])}><option value="MEMBER">Member</option><option value="VIEWER">Viewer</option>{isOwner && <option value="ADMIN">Admin</option>}</select> : <span className={`member-role ${member.role === "OWNER" ? "owner-role" : ""}`}>{member.role.toLowerCase()}</span>}{canManage && <button className="remove-member" onClick={() => onRemove(member)} aria-label={`Remove ${member.name}`} title="Remove member"><X size={15} /></button>}</div>; })}{members.length === 0 && <p className="empty-state">No members found.</p>}</div></section></div>;
}

function TaskDialog({ task, members, onClose, onSave, onDelete }: { task: Task; members: Member[]; onClose: () => void; onSave: (task: Task, title: string, description: string, status: TaskStatus, label: string, assigneeId: string) => void; onDelete: (task: Task) => void }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [status, setStatus] = useState(task.status);
  const [label, setLabel] = useState(task.label ?? "");
  const [assigneeId, setAssigneeId] = useState(task.assigneeId ?? "");
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="task-dialog"><header><span className="dialog-kicker">TASK DETAILS <span>·</span> {task.id.slice(-6).toUpperCase()}</span><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></header><input className="dialog-title" value={title} onChange={(event) => setTitle(event.target.value)} /><div className="dialog-meta"><span>Version {task.version}</span></div><div className="task-properties"><label>Status<select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}><option value="TODO">To do</option><option value="IN_PROGRESS">In progress</option><option value="DONE">Done</option></select></label><label>Assignee<select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><label>Label<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={40} placeholder="Add a label" /></label></div><label className="description-label">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add context, acceptance criteria, or links..." rows={6} /></label><footer><button className="delete-button" onClick={() => onDelete(task)}>Delete task</button><div><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={() => onSave(task, title, description, status, label, assigneeId)}>Save changes</button></div></footer></section></div>;
}
