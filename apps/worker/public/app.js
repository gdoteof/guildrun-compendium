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
    ["/players.html", "Players"],
    ["/about.html", "Methodology"],
  ]
    .map(([href, label]) =>
      `<a href="${href}" ${label === active ? 'style="color:var(--accent);font-weight:600"' : ""}>${label}</a>`)
    .join("");
  return `<header class="site"><h1><a href="/">Guildrun Compendium</a></h1><nav>${nav}
    <a href="https://github.com/gdoteof/guildrun-compendium" title="Source on GitHub">GitHub</a></nav>
    <span id="auth-slot" style="margin-left:auto" class="small"></span></header>`;
}

/* Fill the header auth slot after the importing page has injected header().
   Module import completes before the page script runs, so defer one task. */
setTimeout(async () => {
  const slot = document.getElementById("auth-slot");
  if (!slot) return;
  try {
    const res = await fetch("/api/me");
    if (res.ok) {
      const { player } = await res.json();
      slot.innerHTML =
        `<a href="/player.html?id=${encodeURIComponent(player.id)}">${esc(player.label)}</a>
         &middot; <a href="/auth/steam/logout">sign out</a>`;
    } else {
      slot.innerHTML = `<a href="/auth/steam/login">Sign in through Steam</a>`;
    }
  } catch {
    /* leave slot empty */
  }
}, 0);

export const entityLink = (type, ref, name) =>
  `<a href="/entity.html?type=${encodeURIComponent(type)}&ref=${encodeURIComponent(ref)}">${esc(name)}</a>`;
