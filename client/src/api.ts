export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ServerOverview {
  host: string;
  opencodeVersion: string;
  projectCount: number;
  sessionCount: number;
  mainSessionCount: number;
  tokens: Tokens;
  cost: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  worktree: string;
  sessionCount: number;
  mainSessionCount: number;
  tokens: Tokens;
  cost: number;
}

export interface Session {
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

export interface ProjectDetail {
  project: Project;
  sessions: Session[];
}

export interface SessionDetail extends Session {
  version: string;
}

export interface ModelUsage {
  model: string;
  provider: string;
  mode: string;
  messageCount: number;
  tokens: Tokens;
  cost: number;
}

export interface SessionDetailResponse {
  session: SessionDetail;
  models: ModelUsage[];
}

export interface UpdateEvent {
  type: string;
  at?: number;
  scope?: "overview" | "project" | "session";
  id?: string;
}

export interface ServerConfig {
  name: string;
  url: string;
}

export interface DashboardConfigResponse {
  servers: ServerConfig[];
  ui?: { sessionPage?: number };
}

async function getJson<T>(base: string, path: string): Promise<T> {
  const res = await fetch(base + path);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (body.detail) detail = String(body.detail);
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

/** Front-end server proxies /api/s/{i}/* to the i-th configured backend. */
export function baseOf(idx: number): string {
  return `/api/s/${idx}`;
}

export const api = {
  config: () => getJson<DashboardConfigResponse>("/", "api/config"),
  overview: (idx: number) => getJson<ServerOverview>(baseOf(idx), "/overview"),
  projects: (idx: number) => getJson<Project[]>(baseOf(idx), "/projects"),
  project: (idx: number, id: string) => getJson<ProjectDetail>(baseOf(idx), `/projects/${encodeURIComponent(id)}`),
  session: (idx: number, id: string) =>
    getJson<SessionDetailResponse>(baseOf(idx), `/sessions/${encodeURIComponent(id)}`),
};
