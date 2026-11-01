"use strict";

// Storage key for the url->container map persisted across sessions. Schema is
// unchanged from 1.1.0 so upgrades never lose recorded data: { [url]: {
// cookieStoreId, containerName, color, icon, visitedAt, manual? } }.
const STORAGE_KEY = "urlMap";
const META_KEY = "meta";
const MAX_ENTRIES = 10000;
const DEFAULT_COOKIE_STORE_ID = "firefox-default";

// ─── Storage helpers ────────────────────────────────────────────────────────

async function getUrlMap() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

async function saveUrlMap(map) {
  await browser.storage.local.set({ [STORAGE_KEY]: map });
}

async function getMeta() {
  const result = await browser.storage.local.get(META_KEY);
  return result[META_KEY] || {};
}

/**
 * Strips only the URL fragment; preserves the query string because ?page=2
 * and ?page=3 are distinct pages that may have been opened in different
 * containers.
 */
function normaliseUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Discards the oldest non-manual entries when the map exceeds MAX_ENTRIES.
 * Manually-assigned records are exempt: they're explicit user intent, not
 * passive recording, and there are never enough of them to matter for size.
 */
function evictOldest(map) {
  const entries = Object.entries(map);
  if (entries.length <= MAX_ENTRIES) return map;

  const manual = entries.filter(([, v]) => v.manual);
  const evictable = entries.filter(([, v]) => !v.manual);
  evictable.sort((a, b) => a[1].visitedAt - b[1].visitedAt);

  const keep = Math.max(MAX_ENTRIES - manual.length, 0);
  return Object.fromEntries([...evictable.slice(evictable.length - keep), ...manual]);
}

// ─── Container identity cache ───────────────────────────────────────────────

// cookieStoreId -> { name, color, icon }
let containerCache = {};
let cacheReady = false;

async function refreshContainerCache() {
  try {
    const identities = await browser.contextualIdentities.query({});
    const next = {};
    for (const id of identities) {
      next[id.cookieStoreId] = { name: id.name, color: id.color, icon: id.icon };
    }
    next[DEFAULT_COOKIE_STORE_ID] = { name: "Default", color: "toolbar", icon: "circle" };
    containerCache = next;
  } catch {
    // contextualIdentities is unavailable when containers are disabled in about:config.
    containerCache[DEFAULT_COOKIE_STORE_ID] = { name: "Default", color: "toolbar", icon: "circle" };
  } finally {
    cacheReady = true;
  }
}

/**
 * Returns the cached container info, waiting for the first cache fill if
 * needed. Avoids the race where a tab visit fires before refreshContainerCache()
 * resolves on browser startup.
 */
async function getContainerInfo(cookieStoreId) {
  if (!cacheReady) await refreshContainerCache();
  return containerCache[cookieStoreId] ?? { name: cookieStoreId, color: "toolbar", icon: "circle" };
}

browser.contextualIdentities.onCreated.addListener(refreshContainerCache);
browser.contextualIdentities.onUpdated.addListener(refreshContainerCache);
browser.contextualIdentities.onRemoved.addListener(refreshContainerCache);

// Kick off the initial fill; don't await here, getContainerInfo handles the race.
refreshContainerCache();

// ─── Record visits ──────────────────────────────────────────────────────────

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !tab.cookieStoreId) return;
  if (tab.url.startsWith("about:") || tab.url.startsWith("moz-extension:")) return;

  const url = normaliseUrl(tab.url);
  const container = await getContainerInfo(tab.cookieStoreId);

  let map = await getUrlMap();
  map[url] = {
    cookieStoreId: tab.cookieStoreId,
    containerName: container.name,
    color: container.color ?? null,
    icon: container.icon ?? null,
    visitedAt: Date.now(),
  };
  map = evictOldest(map);
  await saveUrlMap(map);
});

// ─── Install bookkeeping ─────────────────────────────────────────────────────

// Recorded once, used by the popup footer to explain why history before this
// date has no container data. Fires on both "install" and "update" so a user
// upgrading from a version that predates this field still gets one, taken as
// the date they first ran a version that records it.
browser.runtime.onInstalled.addListener(async () => {
  const meta = await getMeta();
  if (meta.installedAt) return;
  await browser.storage.local.set({ [META_KEY]: { ...meta, installedAt: Date.now() } });
});

// ─── Context menu ────────────────────────────────────────────────────────────

// Guarded with removeAll() so a background-page restart (or, if this is ever
// ported to MV3's event page, a service-worker wake) can't register the item
// twice.
browser.contextMenus.removeAll().then(() => {
  browser.contextMenus.create({
    id: "open-in-original-container",
    title: "Open in Original Container",
    contexts: ["link"],
  });
});

browser.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "open-in-original-container" || !info.linkUrl) return;
  await openInContainer(info.linkUrl);
});

// ─── Core open logic ─────────────────────────────────────────────────────────

/**
 * Opens rawUrl in a new tab. Uses forceCookieStoreId when given (the user
 * picked a different container at click time); otherwise uses the container
 * it was last visited in. Falls back to the default container if that
 * container no longer exists.
 */
async function openInContainer(rawUrl, forceCookieStoreId, background = false) {
  const url = normaliseUrl(rawUrl);
  const map = await getUrlMap();
  const entry = map[url];

  let cookieStoreId = forceCookieStoreId ?? entry?.cookieStoreId ?? null;
  let containerName = forceCookieStoreId
    ? (await getContainerInfo(forceCookieStoreId)).name
    : entry?.containerName ?? null;

  if (cookieStoreId && cookieStoreId !== DEFAULT_COOKIE_STORE_ID && !containerCache[cookieStoreId]) {
    await refreshContainerCache();
    if (!containerCache[cookieStoreId]) {
      cookieStoreId = DEFAULT_COOKIE_STORE_ID;
      containerName = "Default";
    }
  }

  const props = { url: rawUrl, active: !background };
  if (cookieStoreId && cookieStoreId !== DEFAULT_COOKIE_STORE_ID) props.cookieStoreId = cookieStoreId;
  const tab = await browser.tabs.create(props);
  return { container: containerName, tabId: tab.id };
}

// ─── Message API ─────────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener(async (msg) => {
  switch (msg.type) {
    case "open_in_container":
      return openInContainer(msg.url, msg.cookieStoreId, msg.background === true);

    case "get_history_with_containers": {
      if (!cacheReady) await refreshContainerCache();

      let historyItems;
      try {
        historyItems = await browser.history.search({
          text: msg.text ?? "",
          maxResults: msg.maxResults ?? 300,
          startTime: msg.startTime ?? 0,
          endTime: msg.endTime ?? Date.now(),
        });
      } catch {
        // Return empty array, never an error object: the popup assigns this
        // directly to allItems and calls array methods on it.
        return [];
      }

      const map = await getUrlMap();
      return historyItems.map((item) => {
        const record = map[normaliseUrl(item.url)];
        return {
          id: item.id,
          url: item.url,
          title: item.title || item.url,
          lastVisitTime: item.lastVisitTime,
          visitCount: item.visitCount,
          container: record
            ? {
                cookieStoreId: record.cookieStoreId,
                name: record.containerName,
                color: record.color,
                icon: record.icon,
                manual: record.manual === true,
              }
            : null,
        };
      });
    }

    case "get_containers":
      if (!cacheReady) await refreshContainerCache();
      return containerCache;

    case "get_meta":
      return getMeta();

    case "forget_container": {
      const url = normaliseUrl(msg.url);
      const map = await getUrlMap();
      if (url in map) {
        delete map[url];
        await saveUrlMap(map);
        return { ok: true };
      }
      return { ok: false };
    }

    case "set_container": {
      const url = normaliseUrl(msg.url);
      const container = await getContainerInfo(msg.cookieStoreId);
      let map = await getUrlMap();
      map[url] = {
        cookieStoreId: msg.cookieStoreId,
        containerName: container.name,
        color: container.color ?? null,
        icon: container.icon ?? null,
        visitedAt: Date.now(),
        manual: true,
      };
      map = evictOldest(map);
      await saveUrlMap(map);
      return { ok: true };
    }

    case "delete_history_item": {
      try {
        await browser.history.deleteUrl({ url: msg.url });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }

    default:
      return null;
  }
});
