import { serve } from "bun";

const PORT = 8791;
const T0 = 1785571208048;

interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}
const T = (i: number, o: number, r: number, cr: number, cw: number): Tokens => ({
  input: i,
  output: o,
  reasoning: r,
  cacheRead: cr,
  cacheWrite: cw,
  total: i + o + r + cr + cw,
});

const sessions = [
  {
    id: "s1",
    parentId: null,
    projectId: "proj-a",
    title: "fix cli config parsing",
    agent: "build",
    model: "deepseek-v4-flash",
    timeCreated: T0,
    timeUpdated: T0 + 120000,
    tokens: T(40000, 12000, 8000, 50000, 2000),
    cost: 0.0143,
  },
  {
    id: "s2",
    parentId: "s1",
    projectId: "proj-a",
    title: "review formatting",
    agent: "plan",
    model: "claude-sonnet-4-5",
    timeCreated: T0 + 130000,
    timeUpdated: T0 + 180000,
    tokens: T(8000, 2000, 3000, 9000, 0),
    cost: 0.0031,
  },
  {
    id: "s3",
    parentId: "s2",
    projectId: "proj-a",
    title: "verify on mac",
    agent: "code",
    model: "deepseek-v4-flash",
    timeCreated: T0 + 190000,
    timeUpdated: T0 + 200000,
    tokens: T(500, 200, 100, 0, 0),
    cost: 0.0002,
  },
  {
    id: "s4",
    parentId: null,
    projectId: "proj-b",
    title: "port glob util",
    agent: "build",
    model: "claude-sonnet-4-5",
    timeCreated: T0 + 300000,
    timeUpdated: T0 + 400000,
    tokens: T(90000, 30000, 15000, 40000, 5000),
    cost: 0.082,
  },
];

const projects = [
  {
    id: "proj-b",
    name: "libshell",
    worktree: "/Users/gcszhn/Documents/project/libshell",
    sessionCount: 1,
    tokens: T(90000, 30000, 15000, 40000, 5000),
    cost: 0.082,
  },
  {
    id: "proj-a",
    name: "cli-tools-registry",
    worktree: "/Users/gcszhn/Documents/project/cli-tools-registry",
    sessionCount: 3,
    tokens: T(48500, 14200, 11100, 59000, 2000),
    cost: 0.0176,
  },
];

const sessionDetails: Record<string, { session: Record<string, unknown>; models: unknown[] }> = {
  s1: {
    session: { ...sessions[0], version: "local" },
    models: [
      {
        model: "deepseek-v4-flash",
        provider: "deepseek",
        mode: "build",
        messageCount: 12,
        tokens: T(35000, 10000, 7000, 50000, 2000),
        cost: 0.0111,
      },
      {
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        mode: "plan",
        messageCount: 5,
        tokens: T(5000, 2000, 1000, 0, 0),
        cost: 0.0032,
      },
    ],
  },
  s2: {
    session: { ...sessions[1], version: "local" },
    models: [
      {
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        mode: "plan",
        messageCount: 3,
        tokens: T(8000, 2000, 3000, 9000, 0),
        cost: 0.0031,
      },
    ],
  },
  s3: {
    session: { ...sessions[2], version: "local" },
    models: [],
  },
  s4: {
    session: { ...sessions[3], version: "local" },
    models: [
      {
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        mode: "build",
        messageCount: 21,
        tokens: T(90000, 30000, 15000, 40000, 5000),
        cost: 0.082,
      },
    ],
  },
};

const overview: Record<string, unknown> = {
  host: "mock-machine",
  opencodeVersion: "1.18.10",
  projectCount: 2,
  sessionCount: 4,
  tokens: T(138500, 44200, 26100, 99000, 7000),
  cost: 0.0996,
  updatedAt: Date.now(),
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const enc = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController>();

function broadcast(evt: string, data: unknown): void {
  const payload = `event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try {
      c.enqueue(enc.encode(payload));
    } catch {
      clients.delete(c);
    }
  }
}

setInterval(() => broadcast("", { type: "heartbeat" }), 15000);

let tick = 0;
setInterval(() => {
  tick += 1;
  overview.updatedAt = Date.now();
  broadcast("update", { type: "updated", at: overview.updatedAt, scope: "overview" });
  console.log(`[sse] broadcast #${tick} updated/overview`);
}, 20000);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    console.log(`[req] ${req.method} ${url.pathname}`);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/stream") {
      const source = {
        controller: null as ReadableStreamDefaultController | null,
        start(c: ReadableStreamDefaultController) {
          this.controller = c;
          clients.add(c);
          c.enqueue(
            enc.encode(
              `event: update\ndata: ${JSON.stringify({ type: "updated", at: overview.updatedAt, scope: "overview" })}\n\n`,
            ),
          );
        },
        cancel() {
          if (this.controller) clients.delete(this.controller);
        },
      };
      return new Response(new ReadableStream(source), {
        headers: {
          ...CORS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    if (url.pathname === "/health") return json({ status: "ok", version: "1.18.10" });
    if (url.pathname === "/overview") return json(overview);
    if (url.pathname === "/projects") return json(projects);

    const mProj = url.pathname.match(/^\/projects\/([^/]+)$/);
    if (mProj) {
      const p = projects.find((x) => x.id === mProj[1]);
      if (!p) return json({ detail: "project not found" }, 404);
      return json({ project: p, sessions: sessions.filter((s) => s.projectId === p.id) });
    }

    const mSes = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (mSes) {
      const d = sessionDetails[mSes[1]];
      if (!d) return json({ detail: "session not found" }, 404);
      return json(d);
    }

    return json({ detail: "not found" }, 404);
  },
});

console.log(`mock server on http://127.0.0.1:${PORT} (broadcasts updated/overview every 20s)`);
