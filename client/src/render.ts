import type { Tokens } from "./api";

const SEGS: Array<[keyof Omit<Tokens, "total">, string]> = [
  ["input", "seg-in"],
  ["output", "seg-out"],
  ["reasoning", "seg-rea"],
  ["cacheRead", "seg-cr"],
  ["cacheWrite", "seg-cw"],
];

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

export function fmtCost(n: number): string {
  if (!n) return "$0";
  if (n < 0.0001) return "< $0.0001";
  const s = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return "$" + (s === "" ? "0" : s);
}

export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function tokenBar(tokens: Tokens): HTMLDivElement {
  const bar = el("div", "bar");
  if (!tokens.total) {
    bar.classList.add("bar-empty");
    bar.title = "0 tokens";
    return bar;
  }
  for (const [key, cls] of SEGS) {
    const w = (tokens[key] / tokens.total) * 100;
    if (w <= 0) continue;
    const seg = el("div", `seg ${cls}`);
    seg.style.width = `${w}%`;
    seg.title = `${key}: ${fmtTokens(tokens[key])}`;
    bar.appendChild(seg);
  }
  return bar;
}

/** Shared loading indicator: CSS spinner, optionally with a caption. */
export function spinner(text?: string): HTMLDivElement {
  const wrap = el("div", "loading");
  wrap.appendChild(el("div", "spinner"));
  if (text) wrap.appendChild(el("span", "muted", text));
  return wrap;
}

export function tokenCell(tokens: Tokens, hero = false): HTMLDivElement {
  const wrap = el("div", "tcell" + (hero ? " hero" : ""));
  const barWrap = el("div", "bar-wrap");
  barWrap.appendChild(tokenBar(tokens));
  wrap.append(barWrap, el("span", "num", fmtTokens(tokens.total)));
  return wrap;
}
