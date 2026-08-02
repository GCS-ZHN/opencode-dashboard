import { api, baseOf } from "./api";
import type {
  ModelUsage,
  Project,
  ProjectDetail,
  ServerConfig,
  ServerOverview,
  Session,
  SessionDetailResponse,
  Tokens,
  UpdateEvent,
} from "./api";
import { el, fmtAgo, fmtCost, fmtTokens, tokenCell } from "./render";

let SESSION_PAGE = 30;
let SERVERS: ServerConfig[] = [];
let panels: ServerPanel[] = [];
const ACCENTS = ["#58a6ff", "#3fb950", "#a371f7", "#d29922", "#f85149", "#39c5cf", "#db61a2", "#79c0ff"];

function parseEvent(e: MessageEvent): UpdateEvent | null {
  if (!e.data) return null;
  try {
    return JSON.parse(String(e.data)) as UpdateEvent;
  } catch {
    return null;
  }
}

function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}

/** Click + keyboard (Enter/Space) activation for a drill-down row. */
function bindRow(row: HTMLElement, fn: () => void): void {
  row.tabIndex = 0;
  row.addEventListener("click", fn);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  });
}

class ServerPanel {
  private overview: ServerOverview | null = null;
  private projects: Project[] = [];
  private models: ModelUsage[] = [];
  private projectDetails = new Map<string, ProjectDetail>();
  private sessionDetails = new Map<string, SessionDetailResponse>();
  private expandedProjects = new Set<string>();
  private expandedSessions = new Set<string>();
  private sessionLimits = new Map<string, number>();
  private error: string | null = null;
  private es: EventSource | null = null;
  private liveRef: HTMLSpanElement | null = null;
  private updRef: HTMLSpanElement | null = null;

  readonly root: HTMLElement;
  private readonly base: string;

  constructor(private idx: number) {
    this.base = SERVERS[idx]?.url ?? "";
    this.root = el("section", "server");
    this.root.dataset.url = this.base;
  }

  start(): void {
    this.connect();
    void this.refresh();
  }

  touch(): void {
    if (this.updRef && this.overview) {
      this.updRef.textContent = `updated ${fmtAgo(this.overview.updatedAt)}`;
    }
  }

  private connect(): void {
    this.es?.close();
    const es = new EventSource(`${baseOf(this.idx)}/stream`);
    this.es = es;
    const handle = (e: MessageEvent) => this.onUpdate(parseEvent(e));
    es.addEventListener("update", handle);
    es.onmessage = handle;
    es.onopen = () => this.setLive(true);
    es.onerror = () => this.setLive(false);
  }

  private setLive(up: boolean): void {
    if (this.liveRef) {
      this.liveRef.textContent = up ? "● live" : "reconnecting…";
      this.liveRef.classList.toggle("on", up);
    }
  }

  private async refresh(): Promise<void> {
    try {
      const [ov, projects, models] = await Promise.all([
        api.overview(this.idx),
        api.projects(this.idx),
        api.models(this.idx).catch((e) =>
          /\b404\b/.test(e instanceof Error ? e.message : String(e)) ? null : Promise.reject(e),
        ),
      ]);
      this.overview = ov;
      this.projects = projects;
      this.models = models ?? [];
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  private async loadProject(id: string): Promise<void> {
    if (!this.expandedProjects.has(id)) return;
    try {
      this.projectDetails.set(id, await api.project(this.idx, id));
    } catch {
      this.expandedProjects.delete(id);
    }
    this.render();
  }

  private async loadSession(id: string): Promise<void> {
    if (!this.expandedSessions.has(id)) return;
    try {
      this.sessionDetails.set(id, await api.session(this.idx, id));
    } catch {
      this.expandedSessions.delete(id);
    }
    this.render();
  }

  private onUpdate(ev: UpdateEvent | null): void {
    if (!ev || ev.type !== "updated") return;
    // server emits scope "overview" only: refresh headline data plus anything
    // the user has expanded so open trees don't go stale
    const tasks: Promise<void>[] = [this.refresh()];
    for (const id of this.expandedProjects) tasks.push(this.loadProject(id));
    for (const id of this.expandedSessions) tasks.push(this.loadSession(id));
    void Promise.all(tasks);
  }

  private render(): void {
    this.root.replaceChildren();
    if (this.error && !this.overview) {
      const err = el("div", "error");
      err.append(el("h3", "", this.base), el("p", "", this.error));
      const retry = el("button", "", "Retry");
      retry.addEventListener("click", () => void this.refresh());
      err.appendChild(retry);
      this.root.appendChild(err);
      return;
    }

    const ov = this.overview;
    const head = el("header", "srv-head");
    head.append(
      el("h2", "srv-host", ov ? ov.host : this.base),
      el("span", "srv-ver", ov ? `opencode ${ov.opencodeVersion}` : ""),
      el("span", "srv-url", this.base),
    );
    const live = el("span", "live");
    this.liveRef = live;
    this.setLive(this.es?.readyState === EventSource.OPEN);
    const upd = el("span", "srv-upd");
    this.updRef = upd;
    this.touch();
    head.append(live, mcpLink(), upd);
    this.root.appendChild(head);

    const stats = el("div", "stats");
    const sStat = stat("sessions", ov ? sessionCountLabel(ov.mainSessionCount, ov.sessionCount) : "…");
    sStat.title = ov ? `${ov.mainSessionCount} main sessions · ${ov.sessionCount} total (incl. subagents)` : "";
    stats.append(
      sStat,
      stat("projects", ov ? String(ov.projectCount) : "…"),
    );
    const tStat = el("div", "stat stat-tokens");
    tStat.appendChild(el("span", "lbl", "tokens"));
    if (ov) tStat.appendChild(tokenCell(ov.tokens, true));
    else tStat.appendChild(el("div", "skeleton", ""));
    stats.appendChild(tStat);
    stats.appendChild(statCost(ov ? ov.cost : null));
    this.root.appendChild(stats);

    if (this.error) {
      this.root.appendChild(el("div", "error error-bar", `refresh failed: ${this.error}`));
    }

    if (ov) {
      this.root.appendChild(this.pies());
    }

    this.root.appendChild(el("h3", "sec-head", "Projects"));
    if (!ov) {
      const tbl = el("table", "tbl");
      const tbody = el("tbody");
      for (let i = 0; i < 3; i++) {
        const tr = el("tr", "skeleton-row");
        const td = el("td");
        td.colSpan = 4;
        td.appendChild(el("div", "skeleton"));
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      this.root.appendChild(tbl);
      return;
    }

    if (this.projects.length === 0) {
      this.root.appendChild(el("div", "empty", "No projects found on this host."));
      return;
    }

    const tbl = el("table", "tbl");
    const thead = el("thead");
    const htr = el("tr");
    for (const t of ["Project", "Sessions", "Tokens", "Cost"]) htr.appendChild(el("th", "", t));
    thead.appendChild(htr);
    tbl.appendChild(thead);
    const tbody = el("tbody");
    for (const p of this.projects) this.renderProject(tbody, p);
    tbl.appendChild(tbody);
    this.root.appendChild(tbl);
  }

  private pies(): HTMLElement {
    const grid = el("div", "pies");
    const model = this.models.map((m) => ({ label: m.model, value: m.tokens.total }));
    const modelCost = this.models.map((m) => ({ label: m.model, value: m.cost }));
    const project = this.projects.map((p) => ({ label: p.name, value: p.tokens.total }));
    const projectCost = this.projects.map((p) => ({ label: p.name, value: p.cost }));
    grid.append(
      pieCard("Tokens by model", model, fmtTokens),
      pieCard("Cost by model", modelCost, fmtCost, "No cost reported"),
      pieCard("Tokens by project", project, fmtTokens),
      pieCard("Cost by project", projectCost, fmtCost, "No cost reported"),
    );
    return grid;
  }

  private renderProject(tbody: HTMLElement, p: Project): void {
    const expanded = this.expandedProjects.has(p.id);
    const nameTd = el("td", "p-name");
    nameTd.append(el("span", "tgl", expanded ? "▾" : "▸"), el("span", "", p.name));
    const tokenTd = el("td");
    tokenTd.appendChild(tokenCell(p.tokens));
    const tr = el("tr", "prow" + (expanded ? " open" : ""));
    tr.append(
      nameTd,
      countTd(p),
      tokenTd,
      el("td", "cost", fmtCost(p.cost)),
    );
    bindRow(tr, () => this.toggleProject(p.id));
    tbody.appendChild(tr);

    if (expanded) {
      const dtr = el("tr", "pdetail");
      const td = el("td");
      td.colSpan = 4;
      const detail = this.projectDetails.get(p.id);
      if (!detail) {
        td.appendChild(el("div", "muted", "Loading…"));
      } else {
        const limit = this.sessionLimits.get(p.id) ?? SESSION_PAGE;
        const tree = el("div", "stree");
        this.renderSessions(tree, detail.sessions, limit, () => {
          this.sessionLimits.set(p.id, limit + SESSION_PAGE);
          this.render();
        });
        td.appendChild(tree);
      }
      dtr.appendChild(td);
      tbody.appendChild(dtr);
    }
  }

  private toggleProject(id: string): void {
    if (this.expandedProjects.has(id)) {
      this.expandedProjects.delete(id);
      this.sessionLimits.delete(id);
      this.render();
    } else {
      this.expandedProjects.add(id);
      void this.loadProject(id);
    }
  }

  private renderSessions(
    cont: HTMLElement,
    sessions: Session[],
    limit: number,
    onMore: () => void,
  ): void {
    const byId = new Map(sessions.map((s) => [s.id, s] as const));
    const children = new Map<string, Session[]>();
    const roots: Session[] = [];
    for (const s of sessions) {
      if (s.parentId && byId.has(s.parentId)) {
        const arr = children.get(s.parentId) ?? [];
        arr.push(s);
        children.set(s.parentId, arr);
      } else {
        roots.push(s); // roots + orphans
      }
    }

    // file-tree semantics: a session row's tokens/cost = itself + all descendants
    const sums = new Map<string, { tokens: Tokens; cost: number }>();
    const compute = (s: Session): { tokens: Tokens; cost: number } => {
      let t: Tokens = { ...s.tokens };
      let c = s.cost;
      for (const k of children.get(s.id) ?? []) {
        const r = compute(k);
        t = addTokens(t, r.tokens);
        c += r.cost;
      }
      const res = { tokens: t, cost: c };
      sums.set(s.id, res);
      return res;
    };
    for (const r of roots) compute(r);

    for (const s of roots.slice(0, limit)) {
      this.renderSession(cont, s, 0, children, sums);
    }
    if (roots.length > limit) {
      const more = el("button", "more", `Show ${roots.length - limit} more sessions`);
      more.addEventListener("click", onMore);
      cont.appendChild(more);
    }
  }

  private renderSession(
    cont: HTMLElement,
    s: Session,
    depth: number,
    children: Map<string, Session[]>,
    sums: Map<string, { tokens: Tokens; cost: number }>,
  ): void {
    const kids = children.get(s.id) ?? [];
    const expanded = this.expandedSessions.has(s.id);
    const sum = sums.get(s.id) ?? { tokens: s.tokens, cost: s.cost };
    const row = el("div", "srow" + (expanded ? " open" : ""));
    row.style.setProperty("--depth", String(depth));
    const tgl = el("span", "tgl", expanded ? "▾" : "▸");
    if (kids.length) {
      const badge = el("span", "badge", String(kids.length));
      tgl.append(badge);
    }
    const main = el("div", "s-main");
    main.append(
      el("span", "s-title", s.title || "Untitled session"),
      el("span", "s-meta", `${s.agent} · ${s.model}`),
    );
    row.append(tgl, main, tokenCell(sum.tokens), el("span", "cost", fmtCost(sum.cost)));
    bindRow(row, () => this.toggleSession(s.id));
    cont.appendChild(row);

    if (expanded) {
      const detail = el("div", "s-detail");
      detail.style.setProperty("--depth", String(depth + 1));
      const det = this.sessionDetails.get(s.id);
      if (!det) {
        detail.appendChild(el("div", "muted", "Loading…"));
      } else if (det.models.length === 0) {
        detail.appendChild(el("div", "muted", "No token usage recorded"));
      } else {
        detail.appendChild(this.modelsTable(det.models));
        if (kids.length) {
          detail.appendChild(
            el("div", "muted note", "model breakdown counts only this session — row totals include subagents"),
          );
        }
      }
      cont.appendChild(detail);
    }
    if (expanded) {
      for (const c of kids) {
        this.renderSession(cont, c, depth + 1, children, sums);
      }
    }
  }

  private toggleSession(id: string): void {
    if (this.expandedSessions.has(id)) {
      this.expandedSessions.delete(id);
      this.render();
    } else {
      this.expandedSessions.add(id);
      void this.loadSession(id);
    }
  }

  private modelsTable(models: ModelUsage[]): HTMLElement {
    const tbl = el("table", "tbl tbl-models");
    const thead = el("thead");
    const htr = el("tr");
    for (const t of ["Model", "Mode", "Msgs", "Tokens", "Cost"]) htr.appendChild(el("th", "", t));
    thead.appendChild(htr);
    tbl.appendChild(thead);
    const tbody = el("tbody");
    for (const m of models) {
      const name = el("td", "p-name");
      name.append(el("span", "", m.model), el("span", "muted", m.provider));
      const tokenTd = el("td");
      tokenTd.appendChild(tokenCell(m.tokens));
      const tr = el("tr");
      tr.append(name, el("td", "", m.mode), el("td", "num", String(m.messageCount)), tokenTd, el("td", "cost", fmtCost(m.cost)));
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    return tbl;
  }
}

function stat(label: string, value: string): HTMLElement {
  const s = el("div", "stat");
  s.append(el("span", "num", value), el("span", "lbl", label));
  return s;
}

/** Copy the MCP endpoint URL (current origin + /mcp) to the clipboard. */
async function copyMcpUrl(link: HTMLAnchorElement): Promise<void> {
  const text = `${location.origin}/mcp`;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("clipboard unavailable");
    }
  } catch {
    // Fallback: hidden textarea + execCommand (http / older browsers).
    const ta = el("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const wasCopied = link.classList.contains("copied");
  const label = wasCopied ? "mcp" : link.textContent;
  link.textContent = "copied";
  link.classList.add("copied");
  setTimeout(() => {
    link.textContent = label;
    link.classList.remove("copied");
  }, 1200);
}

function mcpLink(): HTMLAnchorElement {
  const a = el("a", "mcp", "mcp");
  a.href = `${location.origin}/mcp`;
  a.title = "Copy MCP endpoint URL";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    void copyMcpUrl(a);
  });
  return a;
}

/** "3 / 6" = main sessions (roots) / total sessions (incl. subagents). */
function sessionCountLabel(main: number, total: number): string {
  return `${main} / ${total}`;
}

function countTd(p: Project): HTMLElement {
  const td = el("td", "num", sessionCountLabel(p.mainSessionCount, p.sessionCount));
  td.title = `${p.mainSessionCount} main sessions · ${p.sessionCount} total (incl. subagents)`;
  return td;
}

function statCost(value: number | null): HTMLElement {
  const s = el("div", "stat stat-cost");
  s.append(el("span", "num", value === null ? "…" : fmtCost(value)), el("span", "lbl", "cost"));
  return s;
}

/** Donut with legend. Renders `empty` (default "No data") when nothing has a value. */
function pieChart(entries: { label: string; value: number }[], fmt: (n: number) => string, empty = "No data"): HTMLElement {
  const card = el("div", "pie");
  const total = entries.reduce((s, e) => s + e.value, 0);
  if (total <= 0) {
    card.appendChild(el("div", "pie-empty", empty));
    return card;
  }
  const legend = el("ul", "pie-legend");
  const stops: string[] = [];
  let acc = 0;
  entries.forEach((e, i) => {
    const c = ACCENTS[i % ACCENTS.length];
    const a = (acc / total) * 360;
    acc += e.value;
    stops.push(`${c} ${a}deg ${(acc / total) * 360}deg`);
    const item = el("li", "pie-item");
    const swatch = el("span", "pie-swatch");
    swatch.style.background = c;
    item.append(
      swatch,
      el("span", "pie-label", e.label),
      el("span", "pie-val", fmt(e.value)),
    );
    legend.appendChild(item);
  });
  const donut = el("div", "donut");
  donut.style.background = `conic-gradient(${stops.join(", ")})`;
  donut.setAttribute("role", "img");
  donut.setAttribute("aria-label", entries.map((e) => `${e.label}: ${fmt(e.value)}`).join(", "));
  const hole = el("div", "donut-hole");
  hole.appendChild(el("span", "", fmt(total)));
  donut.appendChild(hole);
  card.append(donut, legend);
  return card;
}

function pieCard(title: string, entries: { label: string; value: number }[], fmt: (n: number) => string, empty?: string): HTMLElement {
  const card = el("div", "pie-card");
  card.append(el("h4", "pie-title", title), pieChart(entries, fmt, empty));
  return card;
}

const app = document.getElementById("app")!;

async function boot(): Promise<void> {
  let servers: ServerConfig[] = [];
  let configError: string | null = null;
  try {
    const cfg = await api.config();
    servers = cfg.servers;
    SESSION_PAGE = cfg.ui?.sessionPage ?? SESSION_PAGE;
  } catch (e) {
    configError = e instanceof Error ? e.message : String(e);
  }
  SERVERS = servers;

  if (configError !== null || servers.length === 0) {
    const err = el("div", "error");
    err.append(
      el("h3", "", "No front-end server configuration"),
      el("p", "", configError ?? "No servers returned by /api/config — check dashboard.yaml."),
    );
    const retry = el("button", "", "Retry");
    retry.addEventListener("click", () => void boot());
    err.appendChild(retry);
    app.replaceChildren(err);
    return;
  }

  if (servers.length > 1) app.classList.add("multi");
  panels = [];
  for (let i = 0; i < servers.length; i++) {
    const panel = new ServerPanel(i);
    panel.root.style.borderTop = `3px solid ${ACCENTS[i % ACCENTS.length]}`;
    panels.push(panel);
    app.appendChild(panel.root);
    panel.start();
  }

  // Tabs: "Overall" = all servers side by side; one tab per server to focus it.
  const OVERALL = "overall";
  const tabs = el("nav", "tabs");
  const tabBtns = new Map<string, HTMLButtonElement>();
  const addTab = (label: string, key: string) => {
    const b = el("button", "tab", label);
    b.addEventListener("click", () => setView(key));
    tabs.appendChild(b);
    tabBtns.set(key, b);
  };
  addTab("Overall", OVERALL);
  servers.forEach((s, i) => addTab(s.name, String(i)));
  app.before(tabs);

  function setView(key: string): void {
    const overall = key === OVERALL;
    app.classList.toggle("multi", overall && servers.length > 1);
    panels.forEach((p, i) => {
      p.root.hidden = !(overall || String(i) === key);
    });
    for (const [k, b] of tabBtns) b.classList.toggle("active", k === key);
  }
  setView(OVERALL);
}

void boot();

setInterval(() => {
  for (const p of panels) p.touch();
}, 30_000);
