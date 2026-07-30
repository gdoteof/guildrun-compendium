/* Shared helpers for the Compendium pages. */

export async function api(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* Tier badge: color from the validated ordinal ramp; the LETTER carries
   identity (never color alone). */
export const tierBadge = (tier) =>
  tier
    ? `<span class="badge" style="background:var(--tier-${esc(tier)});color:var(--tier-ink-${esc(tier)})">${esc(tier)}</span>`
    : `<span class="small">–</span>`;

export const rarityLabel = (r) =>
  r ? `<span class="rarity" style="color:var(--rar-${esc(r)})">${esc(r)}</span>` : "";

/* In-table micro bar with a direct % label (tabular-nums). */
export const winBar = (wins, n) => {
  if (!n) return `<span class="small">–</span>`;
  const pct = (wins / n) * 100;
  return `<span class="winbar" title="${wins} of ${n}">
    <span class="track"><span class="fill" style="width:${pct.toFixed(0)}%"></span></span>
    <span class="lbl">${pct.toFixed(0)}%</span></span>`;
};

export const fmtLift = (x) =>
  x == null ? "–" : `<span style="color:${x >= 1 ? "var(--good)" : "var(--bad)"}">${x.toFixed(2)}×</span>`;

export function header(active) {
  const nav = [
    ["/", "Overview"],
    ["/tiers.html", "Tier lists"],
    ["/about.html", "Methodology"],
  ]
    .map(([href, label]) =>
      `<a href="${href}" ${label === active ? 'style="color:var(--accent);font-weight:600"' : ""}>${label}</a>`)
    .join("");
  return `<header class="site"><h1><a href="/">Guildrun Compendium</a></h1><nav>${nav}</nav></header>`;
}

export const entityLink = (type, ref, name) =>
  `<a href="/entity.html?type=${encodeURIComponent(type)}&ref=${encodeURIComponent(ref)}">${esc(name)}</a>`;
