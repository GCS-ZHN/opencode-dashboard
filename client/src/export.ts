// xlsx@0.18.5 (pinned — the last npm release; fixes live only on SheetJS's
// own registry) has two known HIGH CVEs (CVE-2023-30533, CVE-2024-22363),
// both parse-path flaws. This module is strictly write-only (book_new /
// aoa_to_sheet / writeFile — never XLSX.read on untrusted files), so they
// are not exploitable here. If anyone ever adds a read path, revisit the
// pinned CDN tarball (https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz).
import { api } from "./api";
import type { Session, Tokens } from "./api";

export interface ExportTarget {
  idx: number;
  name: string;
}

// Column order follows the reference export_token_usage.py session sheet
// (identification first, then the five token columns, total, cost).
const HEADERS = [
  "Project",
  "Session ID",
  "Parent ID",
  "Title",
  "Agent",
  "Model",
  "Created",
  "Updated",
  "Input Tokens",
  "Output Tokens",
  "Reasoning",
  "Cache Read",
  "Cache Write",
  "Total Tokens",
  "Cost ($)",
];

const TOKEN_KEYS: Array<keyof Omit<Tokens, "total">> = [
  "input",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
];

function ts(ms: number): string {
  return new Date(ms).toISOString();
}

function str(v: string | null | undefined): string {
  return v ?? "";
}

function sessionRow(projectName: string, s: Session): Array<string | number> {
  const t = s.tokens;
  return [
    projectName,
    s.id,
    str(s.parentId),
    str(s.title),
    str(s.agent),
    str(s.model),
    ts(s.timeCreated),
    ts(s.timeUpdated),
    ...TOKEN_KEYS.map((k) => t[k]),
    t.total,
    s.cost,
  ];
}

/** SheetJS sheet-name rules: ≤31 chars, no []:*?/\\ */
export function sheetName(name: string): string {
  return name.replace(/[\[\]:*?/\\]/g, "_").slice(0, 31);
}

async function serverRows(idx: number): Promise<Array<Array<string | number>>> {
  const projects = await api.projects(idx);
  const details = await Promise.all(projects.map((p) => api.project(idx, p.id)));
  const rows: Array<Array<string | number>> = [HEADERS];
  for (const d of details) {
    const sessions = d.sessions.slice().sort((a, b) => a.timeCreated - b.timeCreated);
    for (const s of sessions) rows.push(sessionRow(d.project.name, s));
  }
  return rows;
}

/**
 * Fetch fresh data per server and write one workbook; one sheet per server
 * named after the server, flat tabular (row 1 = header, then one row per
 * session). Per-session model breakdown rows are intentionally skipped: that
 * is one `api.session` fetch per session (N+1 fan-out) for little added value
 * at large session counts.
 */
export async function exportServers(targets: ExportTarget[]): Promise<void> {
  const XLSX = await import("xlsx"); // lazy chunk; ~800KB only loaded on export
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const t of targets) {
    const rows = await serverRows(t.idx);
    let name = sheetName(t.name);
    // Duplicate sheet names throw in book_append_sheet and kill the whole
    // workbook; dedupe with a " (n)" suffix when sanitization collides.
    for (let n = 2; used.has(name); n++) name = `${sheetName(t.name).slice(0, 28)} (${n})`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  XLSX.writeFile(wb, `opencode-usage-${stamp}.xlsx`);
}
