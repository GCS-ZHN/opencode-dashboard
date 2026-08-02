import type { TimeRange } from "./api";

/** Midnight of `d` in local time. */
export function startOfDay(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** Midnight of the next calendar day. Uses local date arithmetic, so it stays
 * on midnight across DST transitions (adding 86_400_000ms absolute would land
 * at 23:00/01:00 and floor back to the same day on a fall-back day). */
export function nextDay(ms: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Preset (today/7d) + custom date inputs → half-open [since, until) window.
 * Pure: DOM reads and Date.now() are passed in by the caller. */
export function computeRange(
  sel: string,
  now: number,
  sinceVal?: string,
  untilVal?: string,
): TimeRange | null {
  if (sel === "today") return { since: startOfDay(new Date(now)), until: nextDay(now) };
  if (sel === "7d") return { since: startOfDay(new Date(now - 6 * 86_400_000)), until: nextDay(now) };
  if (sel === "custom") {
    let since = sinceVal ? new Date(`${sinceVal}T00:00:00`).getTime() : undefined;
    let until = untilVal ? new Date(`${untilVal}T00:00:00`).getTime() : undefined;
    if (since === undefined && until === undefined) return null;
    // Inverted custom window (since after until): swap before expanding the
    // until side, so the "until day inclusive" window lands on the earlier date.
    if (since !== undefined && until !== undefined && since > until) {
      [since, until] = [until, since];
    }
    return {
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until: nextDay(until) } : {}),
    };
  }
  return null;
}
