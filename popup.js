"use strict";

// Firefox container colour name -> CSS suffix used for .accent-* and .badge-* classes.
const COLOR_SUFFIX = {
  blue: "blue", turquoise: "turquoise", green: "green", yellow: "yellow",
  orange: "orange", red: "red", pink: "pink", purple: "purple", toolbar: "toolbar",
};

// Resolved colour values matching popup.css, used for dropdown dots and letter avatars.
const COLOR_HEX = {
  blue: "#5b9cf6", turquoise: "#00c5a0", green: "#52c462", yellow: "#f5c230",
  orange: "#f5882c", red: "#f55252", pink: "#e855e8", purple: "#9b55f5",
  toolbar: "#6e7898",
};

const DEFAULT_COOKIE_STORE_ID = "firefox-default";
const UNTRACKED = "__untracked__";
const PAGE_SIZE = 400;

// ─── Module state ───────────────────────────────────────────────────────────

let allItems = [];           // enriched history items loaded so far for the current search
let containers = {};         // cookieStoreId -> { name, color, icon }
let activeContainerId = "";  // "" = All, UNTRACKED = no record, else a cookieStoreId
let sortMode = "recent";     // "recent" | "frequent" | "alpha"
let lastSearchText = "";
let oldestLoadedTime = null; // lastVisitTime of the oldest item loaded, drives "load more"
let hasMore = false;
let loadedIds = new Set();   // history item ids already in allItems, dedupes across "load more" pages

let visibleRows = [];        // li elements currently rendered, in display order
let kbdIndex = -1;           // index into visibleRows for keyboard navigation

let rowMenuState = null;     // { url, item, view, x, y, confirmDelete }

// ─── Init ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("search").addEventListener("input", debounce(onSearch, 220));
  document.getElementById("retry-btn").addEventListener("click", () => loadHistory(lastSearchText, { reset: true }));
  document.getElementById("load-more-btn").addEventListener("click", loadMore);
  document.getElementById("sort-select").addEventListener("change", (e) => {
    sortMode = e.target.value;
    renderList();
  });
  document.getElementById("filter-btn").addEventListener("click", toggleFilterPanel);

  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("contextmenu", (e) => {
    // Block the native context menu everywhere except inside our own rows,
    // which call e.preventDefault() themselves before this ever fires.
    if (!e.target.closest(".h-row")) return;
  });

  loadMeta();
  Promise.all([loadContainers(), loadHistory("", { reset: true })]);
});

async function loadMeta() {
  let meta;
  try {
    meta = await browser.runtime.sendMessage({ type: "get_meta" });
  } catch {
    return;
  }
  const el = document.getElementById("recording-since");
  if (meta?.installedAt) {
    const date = new Date(meta.installedAt).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    });
    el.textContent = `Recording container history since ${date}`;
  } else {
    el.textContent = "Container history is recorded from first install onward";
  }
}

async function loadContainers() {
  try {
    containers = (await browser.runtime.sendMessage({ type: "get_containers" })) || {};
  } catch {
    containers = {};
  }
  renderFilterPanel();
  updateFilterButton();
}

// ─── Data loading ───────────────────────────────────────────────────────────

async function loadHistory(searchText, { reset } = {}) {
  lastSearchText = searchText;
  setLoading(true);
  showError(false);

  try {
    const results = await browser.runtime.sendMessage({
      type: "get_history_with_containers",
      text: searchText,
      maxResults: PAGE_SIZE,
      startTime: 0,
      endTime: Date.now(),
    });
    allItems = Array.isArray(results) ? results : [];
    loadedIds = new Set(allItems.map((it) => it.id));
    updateLoadMoreState(allItems);
    renderFilterPanel();
    renderList();
  } catch {
    allItems = [];
    loadedIds = new Set();
    showError(true);
  } finally {
    setLoading(false);
  }
}

async function loadMore() {
  if (!hasMore || oldestLoadedTime == null) return;
  const btn = document.getElementById("load-more-btn");
  btn.disabled = true;
  btn.textContent = "Loading…";

  try {
    const results = await browser.runtime.sendMessage({
      type: "get_history_with_containers",
      text: lastSearchText,
      maxResults: PAGE_SIZE,
      startTime: 0,
      // Inclusive of the oldest item already loaded: several items can
      // share the exact same lastVisitTime (burst imports, ms rounding),
      // and an exclusive bound here would silently drop whichever of them
      // landed outside the previous page. Dedupe by id below instead.
      endTime: oldestLoadedTime,
    });
    const rawBatch = Array.isArray(results) ? results : [];
    const batch = rawBatch.filter((it) => !loadedIds.has(it.id));
    for (const it of batch) loadedIds.add(it.id);
    allItems = allItems.concat(batch);
    // A full raw page (pre-dedupe) means the boundary may still hide older
    // items; an undersized one means history is exhausted.
    hasMore = rawBatch.length === PAGE_SIZE;
    updateLoadMoreState(batch, { recomputeHasMore: false });
    renderFilterPanel();
    renderList();
  } catch {
    hasMore = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Load more";
    document.getElementById("load-more-wrap").hidden = !hasMore;
  }
}

function updateLoadMoreState(latestBatch, { recomputeHasMore = true } = {}) {
  if (recomputeHasMore) hasMore = latestBatch.length === PAGE_SIZE;
  if (allItems.length > 0) {
    oldestLoadedTime = allItems.reduce(
      (min, it) => (it.lastVisitTime < min ? it.lastVisitTime : min),
      allItems[0].lastVisitTime,
    );
  } else {
    oldestLoadedTime = null;
  }
  document.getElementById("load-more-wrap").hidden = !hasMore;
}

// ─── Filtering, sorting, grouping ───────────────────────────────────────────

function getFiltered() {
  return allItems.filter((item) => {
    if (!activeContainerId) return true;
    if (activeContainerId === UNTRACKED) return !item.container;
    return item.container?.cookieStoreId === activeContainerId;
  });
}

function getSorted(items) {
  const copy = items.slice();
  if (sortMode === "frequent") {
    copy.sort((a, b) => b.visitCount - a.visitCount || b.lastVisitTime - a.lastVisitTime);
  } else if (sortMode === "alpha") {
    copy.sort((a, b) => domainOf(a.url).localeCompare(domainOf(b.url)) || b.lastVisitTime - a.lastVisitTime);
  } else {
    copy.sort((a, b) => b.lastVisitTime - a.lastVisitTime);
  }
  return copy;
}

/**
 * Buckets items into Today / Yesterday / This Week / This Month / Older.
 * Only meaningful when sorted by recency, so callers only use this in that mode.
 */
function groupByDate(items) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(now);
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;
  const monthAgo = today - 30 * 86400000;

  const buckets = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "This week", items: [] },
    { label: "This month", items: [] },
    { label: "Older", items: [] },
  ];

  for (const item of items) {
    const t = item.lastVisitTime;
    if (t >= today) buckets[0].items.push(item);
    else if (t >= yesterday) buckets[1].items.push(item);
    else if (t >= weekAgo) buckets[2].items.push(item);
    else if (t >= monthAgo) buckets[3].items.push(item);
    else buckets[4].items.push(item);
  }
  return buckets.filter((b) => b.items.length > 0);
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderList() {
  const list = document.getElementById("history-list");
  const emptyState = document.getElementById("empty-state");
  const filtered = getSorted(getFiltered());

  document.getElementById("result-count").textContent =
    filtered.length === allItems.length ? `${filtered.length} shown` : `${filtered.length} of ${allItems.length}`;

  if (filtered.length === 0) {
    list.replaceChildren();
    visibleRows = [];
    kbdIndex = -1;
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  const hideBadge = activeContainerId !== "";
  const frag = document.createDocumentFragment();
  const rows = [];

  // Date grouping only makes sense when sorted by recency; for frequency or
  // alphabetical sort it would scatter semantically-grouped items apart from
  // their visible order, so those render as a flat list instead.
  if (sortMode === "recent") {
    for (const group of groupByDate(filtered)) {
      const heading = document.createElement("li");
      heading.className = "date-heading";
      heading.textContent = group.label;
      frag.appendChild(heading);
      for (const item of group.items) {
        const row = buildRow(item, hideBadge);
        frag.appendChild(row);
        rows.push(row);
      }
    }
  } else {
    for (const item of filtered) {
      const row = buildRow(item, hideBadge);
      frag.appendChild(row);
      rows.push(row);
    }
  }

  // Build off-DOM, then swap in one shot: avoids layout thrash from
  // appending hundreds of rows one at a time.
  list.replaceChildren(frag);
  visibleRows = rows;
  kbdIndex = -1;
}

function buildRow(item, hideBadge) {
  const hasContainer = !!item.container;
  const colorName = item.container?.color ?? null;
  const suffix = hasContainer ? (COLOR_SUFFIX[colorName] ?? "toolbar") : "untracked";
  const containerName = item.container?.name ?? "Untracked";
  const domain = domainOf(item.url);

  const li = document.createElement("li");
  li.className = "h-row";
  li.title = item.url;
  li.dataset.url = item.url;

  const accent = document.createElement("div");
  accent.className = `h-row-accent accent-${suffix}`;
  li.appendChild(accent);

  const faviconWrap = document.createElement("div");
  faviconWrap.className = "h-row-favicon";
  const img = document.createElement("img");
  img.width = 16;
  img.height = 16;
  img.alt = "";
  img.src = `page-icon:${item.url}`;
  img.onerror = () => {
    img.onerror = null;
    img.src = letterAvatarSvg(domain, hasContainer ? (COLOR_HEX[colorName] ?? COLOR_HEX.toolbar) : "#3a3a4e");
  };
  faviconWrap.appendChild(img);
  li.appendChild(faviconWrap);

  const body = document.createElement("div");
  body.className = "h-row-body";

  const title = document.createElement("span");
  title.className = "h-row-title";
  title.textContent = item.title || domain;
  body.appendChild(title);

  const meta = document.createElement("span");
  meta.className = "h-row-meta";
  const visits = item.visitCount === 1 ? "1 visit" : `${item.visitCount} visits`;
  meta.textContent = `${domain} · ${timeAgo(item.lastVisitTime)} · ${visits}`;
  body.appendChild(meta);

  li.appendChild(body);

  if (!hideBadge) {
    const badge = document.createElement("span");
    badge.className = hasContainer ? `h-row-badge badge-${suffix}` : "h-row-badge untracked";
    badge.textContent = containerName;
    li.appendChild(badge);
  }

  const copyBtn = document.createElement("button");
  copyBtn.className = "h-row-copy";
  copyBtn.type = "button";
  copyBtn.title = "Copy URL";
  copyBtn.setAttribute("aria-label", "Copy URL");
  copyBtn.appendChild(copyIconSvg());
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyUrl(item.url);
  });
  li.appendChild(copyBtn);

  li.addEventListener("click", (e) => {
    if (e.button !== 0) return; // left click only; middle click is handled by auxclick
    openItem(item.url, { background: e.ctrlKey || e.metaKey, row: li });
  });
  li.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return; // middle click: open in background, keep popup open
    e.preventDefault();
    openItem(item.url, { background: true, row: li });
  });
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openRowMenu(item, e.clientX, e.clientY);
  });

  return li;
}

// ─── Opening tabs ────────────────────────────────────────────────────────────

/**
 * Opens url via the background script. The popup deliberately stays open:
 * this is a browsing panel, not a one-shot launcher, and closing on every
 * click made multi-item browsing impossible. A brief highlight on the row
 * is the only feedback; the user closes the popup themselves (Escape, or
 * clicking elsewhere) when they're done.
 */
async function openItem(url, { background = false, cookieStoreId, row } = {}) {
  if (row) {
    row.classList.add("opening");
    setTimeout(() => row.classList.remove("opening"), 260);
  }
  try {
    await browser.runtime.sendMessage({ type: "open_in_container", url, cookieStoreId, background });
  } catch {
    // Opening failed; the row highlight already cleared itself, nothing else to roll back.
  }
}

// ─── Filter dropdown ─────────────────────────────────────────────────────────

function computeCounts(items) {
  const counts = { total: items.length, untracked: 0, byContainer: {} };
  for (const item of items) {
    if (!item.container) {
      counts.untracked++;
    } else {
      const id = item.container.cookieStoreId;
      counts.byContainer[id] = (counts.byContainer[id] || 0) + 1;
    }
  }
  return counts;
}

function renderFilterPanel() {
  const panel = document.getElementById("filter-panel");
  panel.replaceChildren();
  const counts = computeCounts(allItems);

  panel.appendChild(makeFilterOption("", "All", null, counts.total));
  for (const [cookieStoreId, info] of Object.entries(containers)) {
    if (cookieStoreId === DEFAULT_COOKIE_STORE_ID) continue;
    panel.appendChild(makeFilterOption(cookieStoreId, info.name, info.color, counts.byContainer[cookieStoreId] || 0));
  }
  if (containers[DEFAULT_COOKIE_STORE_ID]) {
    panel.appendChild(makeFilterOption(
      DEFAULT_COOKIE_STORE_ID, "Default", containers[DEFAULT_COOKIE_STORE_ID].color,
      counts.byContainer[DEFAULT_COOKIE_STORE_ID] || 0,
    ));
  }
  panel.appendChild(makeFilterOption(UNTRACKED, "Untracked", null, counts.untracked, true));
}

function makeFilterOption(id, label, colorName, count, isUntracked = false) {
  const btn = document.createElement("button");
  btn.className = `dropdown-item${id === activeContainerId ? " active" : ""}${isUntracked ? " untracked" : ""}`;
  btn.setAttribute("role", "option");

  const dot = document.createElement("span");
  dot.className = "ctrl-dot";
  if (!isUntracked) dot.style.background = colorName ? (COLOR_HEX[colorName] ?? COLOR_HEX.toolbar) : COLOR_HEX.toolbar;
  btn.appendChild(dot);

  const name = document.createElement("span");
  name.className = "dd-name";
  name.textContent = label;
  btn.appendChild(name);

  const countEl = document.createElement("span");
  countEl.className = "dd-count";
  countEl.textContent = String(count);
  btn.appendChild(countEl);

  btn.addEventListener("click", () => {
    activeContainerId = id;
    updateFilterButton();
    renderFilterPanel();
    renderList();
    closeFilterPanel();
  });
  return btn;
}

function updateFilterButton() {
  const label = document.getElementById("filter-btn-label");
  const dot = document.getElementById("filter-btn-dot");
  if (!activeContainerId) {
    label.textContent = "All";
    dot.style.background = COLOR_HEX.toolbar;
    dot.style.border = "none";
  } else if (activeContainerId === UNTRACKED) {
    label.textContent = "Untracked";
    dot.style.background = "transparent";
    dot.style.border = "1.5px dashed var(--subtext)";
  } else {
    dot.style.border = "none";
    const info = containers[activeContainerId];
    label.textContent = info?.name ?? "Container";
    dot.style.background = info ? (COLOR_HEX[info.color] ?? COLOR_HEX.toolbar) : COLOR_HEX.toolbar;
  }
}

function toggleFilterPanel(e) {
  e.stopPropagation();
  const panel = document.getElementById("filter-panel");
  const btn = document.getElementById("filter-btn");
  const willOpen = panel.hidden;
  closeRowMenu();
  panel.hidden = !willOpen;
  btn.setAttribute("aria-expanded", String(willOpen));
}

function closeFilterPanel() {
  document.getElementById("filter-panel").hidden = true;
  document.getElementById("filter-btn").setAttribute("aria-expanded", "false");
}

// ─── Row context menu ────────────────────────────────────────────────────────

function openRowMenu(item, x, y) {
  closeFilterPanel();
  rowMenuState = { item, url: item.url, view: "main", x, y, confirmDelete: false };
  renderRowMenu();
}

function closeRowMenu() {
  rowMenuState = null;
  document.getElementById("row-menu").hidden = true;
}

function renderRowMenu() {
  const menu = document.getElementById("row-menu");
  if (!rowMenuState) { menu.hidden = true; return; }

  menu.replaceChildren();
  if (rowMenuState.view === "main") renderMenuMain(menu);
  else renderMenuContainerPicker(menu);

  menu.hidden = false;
  positionMenu(menu, rowMenuState.x, rowMenuState.y);
}

function renderMenuMain(menu) {
  const { item } = rowMenuState;

  menu.appendChild(menuAction("Open", () => { openItem(item.url); closeRowMenu(); }));
  menu.appendChild(menuAction("Open in background tab", () => { openItem(item.url, { background: true }); closeRowMenu(); }));
  menu.appendChild(menuAction("Open in a different container", () => { rowMenuState.view = "openin"; renderRowMenu(); }, true));
  menu.appendChild(menuAction("Set remembered container", () => { rowMenuState.view = "setcontainer"; renderRowMenu(); }, true));
  menu.appendChild(menuSeparator());
  menu.appendChild(menuAction("Copy URL", () => { copyUrl(item.url); closeRowMenu(); }));
  if (item.container) {
    menu.appendChild(menuAction("Forget container record", () => forgetContainer(item)));
  }
  menu.appendChild(menuSeparator());

  const deleteLabel = rowMenuState.confirmDelete ? "Click again to confirm delete" : "Delete from history";
  const deleteBtn = menuAction(deleteLabel, () => {
    if (!rowMenuState.confirmDelete) {
      rowMenuState.confirmDelete = true;
      renderRowMenu();
      return;
    }
    deleteHistoryItem(item);
  });
  deleteBtn.classList.add("danger");
  menu.appendChild(deleteBtn);
}

function renderMenuContainerPicker(menu) {
  const { item, view } = rowMenuState;
  const isOpenIn = view === "openin";

  menu.appendChild(menuAction("← Back", () => { rowMenuState.view = "main"; rowMenuState.confirmDelete = false; renderRowMenu(); }, false, "back"));
  menu.appendChild(menuSeparator());

  const entries = Object.entries(containers);
  for (const [cookieStoreId, info] of entries) {
    const dot = document.createElement("span");
    dot.className = "ctrl-dot";
    dot.style.background = COLOR_HEX[info.color] ?? COLOR_HEX.toolbar;

    const btn = document.createElement("button");
    btn.className = "rm-item";
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(info.name));
    btn.addEventListener("click", () => {
      if (isOpenIn) {
        openItem(item.url, { cookieStoreId });
        closeRowMenu();
      } else {
        setContainer(item, cookieStoreId);
      }
    });
    menu.appendChild(btn);
  }
}

function menuAction(label, onClick, hasChevron = false, extraClass = "") {
  const btn = document.createElement("button");
  btn.className = `rm-item${extraClass ? ` ${extraClass}` : ""}`;
  btn.appendChild(document.createTextNode(label));
  if (hasChevron) {
    const chev = document.createElement("span");
    chev.className = "rm-chev";
    chev.textContent = "›";
    btn.appendChild(chev);
  }
  btn.addEventListener("click", onClick);
  return btn;
}

function menuSeparator() {
  const sep = document.createElement("div");
  sep.className = "rm-sep";
  return sep;
}

function positionMenu(menu, x, y) {
  const margin = 8;
  const menuWidth = menu.offsetWidth || 220;
  const menuHeight = menu.offsetHeight || 200;
  const maxX = window.innerWidth - menuWidth - margin;
  const maxY = window.innerHeight - menuHeight - margin;
  menu.style.left = `${Math.max(margin, Math.min(x, maxX))}px`;
  menu.style.top = `${Math.max(margin, Math.min(y, maxY))}px`;
}

async function forgetContainer(item) {
  try {
    await browser.runtime.sendMessage({ type: "forget_container", url: item.url });
  } catch {
    closeRowMenu();
    return;
  }
  item.container = null;
  closeRowMenu();
  renderFilterPanel();
  renderList();
}

async function setContainer(item, cookieStoreId) {
  try {
    await browser.runtime.sendMessage({ type: "set_container", url: item.url, cookieStoreId });
  } catch {
    closeRowMenu();
    return;
  }
  const info = containers[cookieStoreId];
  item.container = {
    cookieStoreId,
    name: info?.name ?? cookieStoreId,
    color: info?.color ?? null,
    manual: true,
  };
  closeRowMenu();
  renderFilterPanel();
  renderList();
}

async function deleteHistoryItem(item) {
  try {
    await browser.runtime.sendMessage({ type: "delete_history_item", url: item.url });
  } catch {
    closeRowMenu();
    return;
  }
  allItems = allItems.filter((it) => it.url !== item.url);
  closeRowMenu();
  renderFilterPanel();
  renderList();
}

function copyUrl(url) {
  navigator.clipboard?.writeText(url).catch(() => {
    // Clipboard permission denied or unavailable: nothing graceful to fall
    // back to inside a popup, so this is a silent no-op.
  });
}

// ─── Global click / keyboard handling ────────────────────────────────────────

function onDocumentClick(e) {
  const filterPanel = document.getElementById("filter-panel");
  if (!filterPanel.hidden && !e.target.closest("#filter-panel") && !e.target.closest("#filter-btn")) {
    closeFilterPanel();
  }
  if (rowMenuState && !e.target.closest("#row-menu")) {
    closeRowMenu();
  }
}

function onKeyDown(e) {
  if (e.key === "Escape") {
    if (rowMenuState) { closeRowMenu(); return; }
    if (!document.getElementById("filter-panel").hidden) { closeFilterPanel(); return; }
    window.close();
    return;
  }

  if (rowMenuState) return; // menu has its own click targets; don't also drive the list

  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveSelection(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveSelection(-1);
  } else if (e.key === "Enter") {
    if (kbdIndex < 0 || !visibleRows[kbdIndex]) return;
    e.preventDefault();
    const url = visibleRows[kbdIndex].dataset.url;
    openItem(url, { background: e.ctrlKey || e.metaKey || e.shiftKey, row: visibleRows[kbdIndex] });
  }
}

function moveSelection(delta) {
  if (visibleRows.length === 0) return;
  if (kbdIndex >= 0) visibleRows[kbdIndex].classList.remove("kbd-active");
  kbdIndex = Math.max(0, Math.min(visibleRows.length - 1, kbdIndex + delta));
  const row = visibleRows[kbdIndex];
  row.classList.add("kbd-active");
  row.scrollIntoView({ block: "nearest" });
}

// ─── UI state helpers ────────────────────────────────────────────────────────

function setLoading(on) {
  document.getElementById("loading-overlay").hidden = !on;
}

function showError(on) {
  document.getElementById("error-state").hidden = !on;
  if (on) document.getElementById("history-list").replaceChildren();
}

function onSearch(e) {
  loadHistory(e.target.value.trim(), { reset: true });
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Returns a tiny inline SVG data URI: a rounded square with the first letter
 * of the domain. Used as a favicon fallback with no external requests.
 */
function letterAvatarSvg(domain, bgColor) {
  const letter = (domain.replace(/^www\./, "")[0] ?? "?").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
    `<rect width="16" height="16" rx="3" fill="${bgColor}"/>` +
    `<text x="8" y="12" font-size="10" font-family="system-ui,sans-serif" ` +
    `text-anchor="middle" fill="rgba(255,255,255,0.92)">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Builds the copy icon as real SVG nodes (no innerHTML/markup string, static content only). */
function copyIconSvg() {
  const svg = svgEl("svg", {
    viewBox: "0 0 16 16", width: "12", height: "12", fill: "none",
    stroke: "currentColor", "stroke-width": "1.3",
    "stroke-linecap": "round", "stroke-linejoin": "round",
  });
  svg.appendChild(svgEl("rect", { x: "5.5", y: "5.5", width: "8", height: "8", rx: "1.3" }));
  svg.appendChild(svgEl("path", { d: "M3 10V3.5A1.5 1.5 0 0 1 4.5 2H10" }));
  return svg;
}

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30)   return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}
