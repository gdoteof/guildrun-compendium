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
  `<a href="/entity.html?type=${encodeURIComponent(type)}&ref=${encodeURIComponent(ref)}"
      data-tip="${esc(type)}:${esc(ref)}">${esc(name)}</a>`;

/* ---------------------------------------------------------------- icons -- */

/* Icons are extracted from the game build per catalog ref; not every entity
   has one, so callers rely on onerror to drop the img. */
export const iconImg = (ref, px = 20) =>
  `<img class="eicon" src="/icons/${encodeURIComponent(ref)}.png" alt=""
        width="${px}" height="${px}" loading="lazy" onerror="this.remove()">`;

/* ------------------------------------------- game description markup ----- */

/* Guildrun text uses [span]<keyword> coloring tags and {N} placeholders whose
   values come from the extracted localisation variables (meta.*Values). */
export function fmtMarkup(text, values = {}) {
  let s = String(text).replace(/\{(\d+)\}/g, (m, k) => values[k] ?? m);
  s = esc(s);
  s = s.replace(/\[([^\[\]]*)\]&lt;([\w/'-]+)&gt;/g, (m, txt, tag) => {
    const cls = tag.toLowerCase().replace(/[^a-z0-9]/g, "");
    return `<span class="kw kw-${cls}">${txt}</span>`;
  });
  return s.replace(/\n/g, "<br>");
}

/* Item stat modifications: [{stat, value}] -> "+25 Attack" chips. */
export const statChips = (stats) =>
  (stats ?? []).map((s) =>
    `<span class="statchip">${s.value > 0 ? "+" : ""}${esc(s.value)} ${esc(s.stat)}</span>`).join(" ");

/* -------------------------------------------------------------- tooltips -- */

let catalogPromise = null;
/** The full content catalog (cached at the edge for 1h); fetched lazily on
 * first hover and shared by every tooltip on the page. */
export function loadCatalog() {
  return (catalogPromise ??= api("/catalog").catch(() => null));
}

function tipBody(type, ref, entry) {
  const meta = entry?.meta ?? {};
  const parts = [];
  parts.push(`<div class="tip-hd">${iconImg(ref, 34)}
    <div><div class="tip-name">${esc(entry?.name ?? ref)}</div>
    ${entry?.rarity ? rarityLabel(entry.rarity) : ""}</div></div>`);
  if (type === "hero") {
    const line = [meta.Classes ? esc(meta.Classes.join(" / ")) : null,
      meta.Guild ? `${esc(meta.Guild)} guild` : null]
      .filter(Boolean).join(" · ");
    if (line) parts.push(`<div class="tip-sub">${line}</div>`);
    const s = meta.Stats ?? {};
    const rows = [["Max HP", "Max HP"], ["Defense", "Defense"], ["Attack", "Attack"],
      ["Magic", "Magic"], ["Attack Speed", "Attack Speed"], ["Crit", "Crit"],
      ["Mana Regen", "Mana Regen"], ["Attack Range", "Range"]]
      .filter(([k]) => s[k] !== undefined && s[k] !== 0);
    if (rows.length) {
      parts.push(`<div class="tip-stats">${rows.map(([k, label]) =>
        `<span>${esc(label)}</span><strong>${esc(s[k])}</strong>`).join("")}</div>`);
    }
    if (meta.Price) parts.push(`<div class="tip-sub">${esc(meta.Price[0])} shards</div>`);
  }
  if (meta.Stats && Array.isArray(meta.Stats)) {
    parts.push(`<div class="tip-line">${statChips(meta.Stats)}</div>`);
  }
  if (meta.Description) {
    parts.push(`<div class="tip-line">${fmtMarkup(meta.Description, meta.DescriptionValues)}</div>`);
  }
  if (meta.QuestDescription) {
    parts.push(`<div class="tip-line"><span class="small">Quest:</span> ${fmtMarkup(meta.QuestDescription, meta.QuestDescriptionValues)}</div>`);
  }
  if (meta.QuestRewardDescription) {
    parts.push(`<div class="tip-line"><span class="small">Reward:</span> ${fmtMarkup(meta.QuestRewardDescription, meta.QuestRewardDescriptionValues)}</div>`);
  }
  return parts.join("");
}

/* One floating tooltip for the whole page, driven by [data-tip="type:Ref"]
   attributes (added automatically by entityLink). Desktop hover only; on
   touch the links still navigate to the detail page. */
function initTooltips() {
  if (!window.matchMedia("(hover: hover)").matches) return;
  const tip = document.createElement("div");
  tip.className = "etip";
  tip.hidden = true;
  document.body.appendChild(tip);

  let current = null;
  const hide = () => { current = null; tip.hidden = true; };

  const place = (target) => {
    const r = target.getBoundingClientRect();
    tip.style.left = "0px"; tip.style.top = "0px";
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = Math.min(r.left, window.innerWidth - tw - 12);
    let y = r.bottom + 8;
    if (y + th > window.innerHeight - 8) y = r.top - th - 8;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  };

  document.addEventListener("mouseover", async (ev) => {
    const el = ev.target.closest?.("[data-tip]");
    if (!el) { if (!ev.target.closest?.(".etip")) hide(); return; }
    if (current === el) return;
    current = el;
    const [type, ref] = el.dataset.tip.split(":");
    const cat = await loadCatalog();
    if (current !== el) return;             // moved on while fetching
    const entry = cat?.[type]?.[ref];
    tip.innerHTML = tipBody(type, ref, entry);
    tip.hidden = false;
    place(el);
  });
  document.addEventListener("scroll", hide, { passive: true, capture: true });
}
initTooltips();
