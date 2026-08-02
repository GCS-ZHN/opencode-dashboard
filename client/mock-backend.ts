// Dev-only mock BACKEND for testing loading animations / caching / time-range
// filtering against a large, slow dataset. Speaks the API.md contract directly
// (like server/app.py, not like the front-end mock-server.ts). Run with bun:
//   bun run mock-backend.ts            (port 8899, ~800ms latency)
//   MOCK_LATENCY=200 bun run mock-backend.ts
import { serve } from "bun";

const PORT = Number(process.env.PORT ?? 8899);
const BASE_DELAY = Number(process.env.MOCK_LATENCY ?? 800);
const delay = () =>
  new Promise((r) => setTimeout(r, BASE_DELAY + Math.floor(Math.random() * BASE_DELAY)));

// Seeded RNG so the dataset is identical across restarts.
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

interface Model {
  model: string;
  provider: string;
  inPrice: number;
  outPrice: number;
}
const MODELS: Model[] = [
  { model: "claude-sonnet-4-5", provider: "anthropic", inPrice: 3e-6, outPrice: 1.5e-5 },
  { model: "deepseek-v4-flash", provider: "deepseek", inPrice: 2.5e-7, outPrice: 1e-6 },
  { model: "gpt-5-mini", provider: "openai", inPrice: 1e-6, outPrice: 4e-6 },
  { model: "claude-haiku-4-5", provider: "anthropic", inPrice: 1e-6, outPrice: 5e-6 },
  { model: "gemini-2.5-flash", provider: "google", inPrice: 1e-6, outPrice: 4e-6 },
  { model: "qwen3-coder", provider: "alibaba", inPrice: 2e-7, outPrice: 6e-7 },
  { model: "grok-code-fast", provider: "xai", inPrice: 3e-6, outPrice: 1.5e-5 },
  { model: "mistral-large", provider: "mistral", inPrice: 2e-6, outPrice: 6e-6 },
  { model: "codestral", provider: "mistral", inPrice: 3e-7, outPrice: 1.5e-6 },
  { model: "o3-mini", provider: "openai", inPrice: 1.1e-6, outPrice: 4.4e-6 },
  { model: "claude-opus-4-1", provider: "anthropic", inPrice: 1.5e-5, outPrice: 7.5e-5 },
  { model: "deepseek-r1", provider: "deepseek", inPrice: 5.5e-7, outPrice: 2.2e-6 },
  { model: "gpt-5", provider: "openai", inPrice: 1.25e-6, outPrice: 1e-5 },
  { model: "kimi-k2", provider: "moonshot", inPrice: 4e-7, outPrice: 1.6e-6 },
  { model: "glm-4.6", provider: "zhipu", inPrice: 2e-7, outPrice: 1e-6 },
];
const AGENTS = ["build", "plan", "code", "debug", "review", "test"];
const TITLES = [
  "fix cli config parsing", "port glob util", "add dark mode", "refactor cache layer",
  "upgrade deps", "write docs", "triage flaky test", "add time-range filter",
  "optimize polling loop", "handle null tokens", "redact secrets", "bump version",
  "reproduce SSE hang", "review PR #42", "add loading spinner", "export to xlsx",
];

interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}
const mkTokens = (): Tokens => {
  const input = int(2000, 90000);
  const output = int(500, 30000);
  const reasoning = rand() < 0.7 ? int(0, 20000) : 0;
  const cacheRead = int(0, 80000);
  const cacheWrite = int(0, 6000);
  return {
    input, output, reasoning, cacheRead, cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
};
const costOf = (t: Tokens, m: Model) =>
  Math.round((t.input * m.inPrice + t.output * m.outPrice) * 1e6) / 1e6;

interface Session {
  id: string;
  parentId: string | null;
  projectId: string;
  title: string;
  agent: string;
  model: string;
  timeCreated: number;
  timeUpdated: number;
  tokens: Tokens;
  cost: number;
}
interface Project {
  id: string;
  name: string;
  worktree: string;
  sessionCount: number;
  mainSessionCount: number;
  tokens: Tokens;
  cost: number;
}

const NOW = Date.now();
const DAY = 86_400_000;
const N_PROJECTS = 120;

const projects: Project[] = [];
const sessions: Session[] = [];
const sessionModels = new Map<string, Model[]>();

for (let p = 0; p < N_PROJECTS; p++) {
  const worktree = `/Users/gcszhn/Documents/project/demo-repo-${String(p).padStart(3, "0")}`;
  const name = worktree.split("/").pop()!;
  const pid = `proj-${String(p).padStart(3, "0")}`;
  const roots = int(1, 4);
  const projSessions: Session[] = [];
  for (let r = 0; r < roots; r++) {
    const id = `${pid}-s${projSessions.length}`;
    const t = mkTokens();
    const m = pick(MODELS);
    const models = [m, ...(rand() < 0.4 ? [pick(MODELS)] : [])];
    sessionModels.set(id, models);
    const tc = NOW - int(0, 90) * DAY - int(0, DAY);
    projSessions.push({
      id, parentId: null, projectId: pid,
      title: pick(TITLES), agent: pick(AGENTS), model: m.model,
      timeCreated: tc, timeUpdated: tc + int(30000, 8 * 3600000),
      tokens: t, cost: costOf(t, m),
    });
    // subagent tree (2-6 deep children)
    const kids = int(2, 6);
    for (let k = 0; k < kids; k++) {
      const cid = `${pid}-s${projSessions.length}`;
      const ct = mkTokens();
      const cm = pick(MODELS);
      sessionModels.set(cid, [cm, ...(rand() < 0.3 ? [pick(MODELS)] : [])]);
      const ctc = tc + int(60000, 3 * 3600000);
      projSessions.push({
        id: cid, parentId: projSessions[projSessions.length - 1]?.id ?? null,
        projectId: pid, title: pick(TITLES), agent: pick(AGENTS), model: cm.model,
        timeCreated: ctc, timeUpdated: ctc + int(30000, 8 * 3600000),
        tokens: ct, cost: costOf(ct, cm),
      });
    }
  }
  const zeroTok = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  const tokens = projSessions.reduce((a, s) => {
    for (const k of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const)
      a[k] += s.tokens[k];
    return a;
  }, zeroTok());
  projects.push({
    id: pid, name, worktree,
    sessionCount: projSessions.length,
    mainSessionCount: projSessions.filter((s) => s.parentId === null).length,
    tokens,
    cost: Math.round(projSessions.reduce((a, s) => a + s.cost, 0) * 1e6) / 1e6,
  });
  sessions.push(...projSessions);
}

// Whole-host per-model rollup (message-granularity proxy: one message-batch per
// session model entry).
const models = (() => {
  const by = new Map<string, { model: string; provider: string; messageCount: number; tokens: Tokens; cost: number }>();
  for (const s of sessions) {
    for (const m of sessionModels.get(s.id) ?? []) {
      const key = `${m.provider}/${m.model}`;
      const e = by.get(key) ?? {
        model: m.model, provider: m.provider, messageCount: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      };
      const share = 1 / (sessionModels.get(s.id)?.length ?? 1);
      e.messageCount++;
      for (const k of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const)
        e.tokens[k] += Math.round(s.tokens[k] * share);
      e.cost += Math.round(s.cost * share * 1e6) / 1e6;
      by.set(key, e);
    }
  }
  return [...by.values()].sort((a, b) => b.cost - a.cost);
})();

const overview = {
  host: "mock-large-host",
  opencodeVersion: "1.18.10",
  dashboardVersion: "0.5.0",
  projectCount: projects.length,
  sessionCount: sessions.length,
  mainSessionCount: sessions.filter((s) => s.parentId === null).length,
  tokens: projects.reduce(
    (a, p) => {
      for (const k of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const)
        a[k] += p.tokens[k];
      return a;
    },
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  ),
  cost: Math.round(projects.reduce((a, p) => a + p.cost, 0) * 1e6) / 1e6,
  updatedAt: NOW,
};

const inRange = (since: number | null, until: number | null) => (ts: number) =>
  (since === null || ts >= since) && (until === null || ts < until);

function overviewWith(since: number | null, until: number | null) {
  const f = inRange(since, until);
  const ss = sessions.filter((s) => f(s.timeCreated));
  const pids = new Set(ss.map((s) => s.projectId));
  const cost = Math.round(ss.reduce((a, s) => a + s.cost, 0) * 1e6) / 1e6;
  const tokens = ss.reduce(
    (a, s) => {
      for (const k of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const)
        a[k] += s.tokens[k];
      return a;
    },
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );
  return { ...overview, projectCount: pids.size, sessionCount: ss.length, mainSessionCount: ss.filter((s) => s.parentId === null).length, tokens, cost };
}

function projectsWith(since: number | null, until: number | null) {
  const f = inRange(since, until);
  return projects
    .map((p) => {
      const ss = sessions.filter((s) => s.projectId === p.id && f(s.timeCreated));
      if (!ss.length) return null;
      return {
        ...p,
        sessionCount: ss.length,
        mainSessionCount: ss.filter((s) => s.parentId === null).length,
        tokens: ss.reduce(
          (a, s) => {
            for (const k of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const)
              a[k] += s.tokens[k];
            return a;
          },
          { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        ),
        cost: Math.round(ss.reduce((a, s) => a + s.cost, 0) * 1e6) / 1e6,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b!.cost - a!.cost);
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const enc = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController>();
setInterval(() => {
  for (const c of clients) {
    try {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`));
    } catch {
      clients.delete(c);
    }
  }
}, 15000);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const since = url.searchParams.get("since") ? Number(url.searchParams.get("since")) : null;
    const until = url.searchParams.get("until") ? Number(url.searchParams.get("until")) : null;
    await delay();

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/health") return json({ status: "ok", version: "1.18.10" });
    if (url.pathname === "/overview") return json(overviewWith(since, until));
    if (url.pathname === "/projects") return json(projectsWith(since, until));
    if (url.pathname === "/models")
      return json(models.filter((m) => sessions.some((s) => sessionModels.get(s.id)?.some((x) => x.model === m.model && inRange(since, until)(s.timeCreated)))));
    if (url.pathname === "/stream") {
      const source = {
        controller: null as ReadableStreamDefaultController | null,
        start(c: ReadableStreamDefaultController) {
          this.controller = c;
          clients.add(c);
          c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`));
        },
        cancel() {
          if (this.controller) clients.delete(this.controller);
        },
      };
      return new Response(new ReadableStream(source), {
        headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }
    const mProj = url.pathname.match(/^\/projects\/([^/]+)$/);
    if (mProj) {
      const p = projects.find((x) => x.id === mProj[1]);
      if (!p) return json({ detail: "project not found" }, 404);
      return json({
        project: p,
        sessions: sessions
          .filter((s) => s.projectId === p.id && inRange(since, until)(s.timeCreated))
          .sort((a, b) => b.cost - a.cost),
      });
    }
    const mSes = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (mSes) {
      const s = sessions.find((x) => x.id === mSes[1]);
      if (!s || !inRange(since, until)(s.timeCreated)) return json({ detail: "session not found" }, 404);
      return json({
        session: s,
        models: (sessionModels.get(s.id) ?? []).map((m) => {
          const share = 1 / (sessionModels.get(s.id)?.length ?? 1);
          const tokens = Object.fromEntries(
            (["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const)
              .map((k) => [k, Math.round(s.tokens[k] * share)]),
          ) as Tokens;
          return { model: m.model, provider: m.provider, mode: pick(AGENTS), messageCount: int(2, 40), tokens, cost: Math.round(s.cost * share * 1e6) / 1e6 };
        }),
      });
    }
    return json({ detail: "not found" }, 404);
  },
});

console.log(
  `mock backend on http://127.0.0.1:${PORT} — ${projects.length} projects, ${sessions.length} sessions, ${models.length} models, ${BASE_DELAY}ms base latency`,
);
