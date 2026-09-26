// "5m ago" and friends, for comments and the Activity page.

/** How long ago `iso` was, briefly: "just now", "5m", "3h", "2d", then the date. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(new Date(t).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}
