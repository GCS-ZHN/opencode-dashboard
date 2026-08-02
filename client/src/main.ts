import { api, baseOf } from "./api";
import type {
  ModelUsage,
  Project,
  ProjectDetail,
  ServerConfig,
  ServerOverview,
  Session,
  SessionDetailResponse,
  TimeRange,
  Tokens,
  UpdateEvent,
} from "./api";
import { el, fmtAgo, fmtCost, fmtTokens, spinner, tokenCell } from "./render";
import { exportServers, type ExportTarget } from "./export";
import { computeRange } from "./range";

let SESSION_PAGE = 30;
let SERVERS: ServerConfig[] = [];
let panels: ServerPanel[] = [];
/** Active time window threaded through every API call (undefined = all time). */
let RANGE: TimeRange | undefined;
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
  /** Bumped on every reload(); stale fetches check this before writing state. */
  private gen = 0;
  /** True while a full reload is in flight (initial load / range switch); shows the panel spinner. */
  private loading = false;
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
    this.render();
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
    const g = this.gen;
    try {
      const [ov, projects, models] = await Promise.all([
        api.overview(this.idx, RANGE),
        api.projects(this.idx, RANGE),
        api.models(this.idx, RANGE).catch((e) =>
          /\b404\b/.test(e instanceof Error ? e.message : String(e)) ? null : Promise.reject(e),
        ),
      ]);
      if (g !== this.gen) return;
      this.overview = ov;
      this.projects = projects;
      this.models = models ?? [];
      this.error = null;
    } catch (e) {
      if (g !== this.gen) return;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.loading = false;
    this.render();
  }

  /** Re-fetch everything for a new range: drop cached drill-down, reload expanded. */
  reload(): Promise<void> {
    ++this.gen;
    this.loading = true;
    this.render();
    this.projectDetails.clear();
    this.sessionDetails.clear();
    const tasks: Promise<void>[] = [this.refresh()];
    for (const id of this.expandedProjects) tasks.push(this.loadProject(id));
    for (const id of this.expandedSessions) tasks.push(this.loadSession(id));
    return Promise.all(tasks).then(() => {});
  }

  private async loadProject(id: string): Promise<void> {
    if (!this.expandedProjects.has(id)) return;
    const g = this.gen;
    try {
      const d = await api.project(this.idx, id, RANGE);
      if (g !== this.gen) return;
      this.projectDetails.set(id, d);
    } catch {
      if (g !== this.gen) return;
      this.expandedProjects.delete(id);
    }
    this.render();
  }

  private async loadSession(id: string): Promise<void> {
    if (!this.expandedSessions.has(id)) return;
    const g = this.gen;
    try {
      const d = await api.session(this.idx, id, RANGE);
      if (g !== this.gen) return;
      this.sessionDetails.set(id, d);
    } catch {
      if (g !== this.gen) return;
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
      el("span", "srv-ver", ov ? `dashboard v${ov.dashboardVersion ?? "?"} · opencode ${ov.opencodeVersion}` : ""),
      el("span", "srv-url", this.base),
    );
    const live = el("span", "live");
    this.liveRef = live;
    this.setLive(this.es?.readyState === EventSource.OPEN);
    const upd = el("span", "srv-upd");
    this.updRef = upd;
    this.touch();
    head.append(live, upd);
    this.root.appendChild(head);

    // Panel-level loading: initial fetch (no overview yet) or a range switch in
    // flight — show a big spinner instead of a blank/stale panel.
    if (this.loading || !ov) {
      const box = el("div", "panel-loading");
      box.appendChild(spinner("Loading…"));
      this.root.appendChild(box);
      return;
    }

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

    if (this.projects.length === 0) {
      this.root.appendChild(
        el("div", "empty", RANGE ? "No data in the selected range." : "No projects found on this host."),
      );
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
        td.appendChild(spinner("Loading sessions…"));
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
      this.render();
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
        detail.appendChild(spinner("Loading model breakdown…"));
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
      this.render();
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

/** Copy the MCP endpoint URL (current origin + /mcp) to the clipboard. The box
 * is one click target: it gets `.copied` and its internal label swaps to "copied". */
async function copyMcpUrl(box: HTMLElement): Promise<void> {
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
  const label = box.querySelector(".mcp-copy");
  if (!label) return;
  const wasCopied = box.classList.contains("copied");
  const prev = wasCopied ? "copy" : label.textContent;
  label.textContent = "copied";
  box.classList.add("copied");
  setTimeout(() => {
    label.textContent = prev;
    box.classList.remove("copied");
  }, 1200);
}

/** Wire the global MCP box in the app header: the whole box (URL + copy) is one
 * click target that copies the endpoint URL (one per dashboard, not per server). */
function bindMcpLink(): void {
  const urlEl = document.getElementById("mcp-url");
  const box = document.getElementById("mcp-box");
  if (!urlEl || !box) return;
  urlEl.textContent = `${location.origin}/mcp`;
  box.addEventListener("click", () => void copyMcpUrl(box));
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

/**
 * Interactive SVG donut. Hovering a slice highlights it and shows that
 * slice's label + value + share in the readout below; no static legend, so
 * the chart stays the focus. Renders `empty` when nothing has a value.
 */
function pieChart(entries: { label: string; value: number }[], fmt: (n: number) => string, empty = "No data"): HTMLElement {
  const card = el("div", "pie");
  const total = entries.reduce((s, e) => s + e.value, 0);
  if (total <= 0) {
    card.appendChild(el("div", "pie-empty", empty));
    return card;
  }

  const SIZE = 120;
  const R = 54;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const polar = (angleDeg: number, radius: number): [number, number] => {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return [CX + radius * Math.cos(rad), CY + radius * Math.sin(rad)];
  };

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("width", String(SIZE));
  svg.setAttribute("height", String(SIZE));
  svg.classList.add("donut");
  const aria = entries.map((e) => `${e.label}: ${fmt(e.value)}`).join(", ");
  svg.setAttribute("aria-label", aria);

  let acc = 0;
  entries.forEach((e, i) => {
    const a0 = (acc / total) * 360;
    acc += e.value;
    const a1 = (acc / total) * 360;
    const [x0, y0] = polar(a0, R);
    const [x1, y1] = polar(a1, R);
    const large = a1 - a0 > 180 ? 1 : 0;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${CX} ${CY} L ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} Z`);
    path.setAttribute("fill", ACCENTS[i % ACCENTS.length]);
    path.setAttribute("stroke", "var(--inset)");
    path.setAttribute("stroke-width", "1");
    path.dataset.label = e.label;
    path.dataset.value = fmt(e.value);
    const pct = ((e.value / total) * 100).toFixed(1).replace(/\.0$/, "");
    path.dataset.pct = pct;
    path.addEventListener("mouseenter", () => showSlice(path));
    svg.appendChild(path);
  });

  const readout = el("div", "pie-readout");
  const setReadout = (text: string, muted: boolean) => {
    readout.textContent = text;
    readout.classList.toggle("muted", muted);
  };
  setReadout(`total ${fmt(total)}`, true);

  function showSlice(slice: SVGPathElement): void {
    for (const p of Array.from(svg.querySelectorAll("path"))) {
      p.classList.toggle("dim", p !== slice);
      p.classList.toggle("hot", p === slice);
    }
    setReadout(`${slice.dataset.label} · ${slice.dataset.value} (${slice.dataset.pct}%)`, false);
  }
  svg.addEventListener("mouseleave", () => {
    for (const p of Array.from(svg.querySelectorAll("path"))) p.classList.remove("dim", "hot");
    setReadout(`total ${fmt(total)}`, true);
  });

  card.append(svg, readout);
  return card;
}

function pieCard(title: string, entries: { label: string; value: number }[], fmt: (n: number) => string, empty?: string): HTMLElement {
  const card = el("div", "pie-card");
  card.append(el("h4", "pie-title", title), pieChart(entries, fmt, empty));
  return card;
}

const app = document.getElementById("app")!;

/** Global time-range control: re-fetch every panel when it changes. */
function bindRange(): void {
  const sel = document.getElementById("range-select") as HTMLSelectElement | null;
  const custom = document.getElementById("range-custom") as HTMLElement | null;
  const apply = () => {
    const sinceVal = (document.getElementById("range-since") as HTMLInputElement | null)?.value;
    const untilVal = (document.getElementById("range-until") as HTMLInputElement | null)?.value;
    RANGE = computeRange(sel?.value ?? "all", Date.now(), sinceVal, untilVal) ?? undefined;
    if (custom) custom.hidden = sel?.value !== "custom";
    void Promise.all(panels.map((p) => p.reload()));
  };
  sel?.addEventListener("change", apply);
  for (const id of ["range-since", "range-until"]) {
    document.getElementById(id)?.addEventListener("change", apply);
  }
}

async function boot(): Promise<void> {
  bindMcpLink();
  bindRange();
  const bootLoading = spinner("Loading dashboard…");
  bootLoading.classList.add("page-loading");
  app.replaceChildren(bootLoading);
  let servers: ServerConfig[] = [];
  let configError: string | null = null;
  try {
    const cfg = await api.config();
    servers = cfg.servers;
    SESSION_PAGE = cfg.ui?.sessionPage ?? SESSION_PAGE;
    const ver = document.getElementById("app-ver");
    if (ver && cfg.version) ver.textContent = `v${cfg.version}`;
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
  app.replaceChildren();
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
  const exportBtn = el("button", "tab tab-export", "Export Excel");
  exportBtn.title = "Download the current view as an .xlsx workbook";
  tabs.appendChild(exportBtn);
  app.before(tabs);

  let current = OVERALL;
  function setView(key: string): void {
    current = key;
    const overall = key === OVERALL;
    app.classList.toggle("multi", overall && servers.length > 1);
    panels.forEach((p, i) => {
      p.root.hidden = !(overall || String(i) === key);
    });
    for (const [k, b] of tabBtns) b.classList.toggle("active", k === key);
  }
  setView(OVERALL);

  exportBtn.addEventListener("click", () => void doExport());

  async function doExport(): Promise<void> {
    const targets: ExportTarget[] =
      current === OVERALL
        ? servers.map((s, i) => ({ idx: i, name: s.name }))
        : [{ idx: Number(current), name: servers[Number(current)]?.name ?? `server-${current}` }];
    exportBtn.disabled = true;
    const label = exportBtn.textContent ?? "";
    exportBtn.textContent = "Exporting…";
    try {
      await exportServers(targets, RANGE);
    } catch (e) {
      alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = label;
    }
  }
}

void boot();

setInterval(() => {
  for (const p of panels) p.touch();
}, 30_000);
