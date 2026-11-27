const DEFAULT_PORT = 19222;
const GROUP_PREFIX = "Fantuan";
const GROUP_COLORS = [
  "blue",
  "cyan",
  "purple",
  "green",
  "orange",
  "pink",
  "yellow",
  "grey",
];

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "slider",
  "spinbutton",
  "treeitem",
]);

const CONTENT_ROLES = new Set([
  "heading",
  "img",
  "status",
  "alert",
  "dialog",
  "navigation",
  "main",
]);

const KEY_DEFINITIONS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

let ws = null;
let currentPort = DEFAULT_PORT;
let reconnectTimer = null;
let pingTimer = null;
let reconnectAttempt = 0;

// Runtime state (reconstructed from Chrome tabGroups on service worker restart)
const attachedTabs = new Set();
const sessionCurrentTab = new Map(); // session -> tabId
const tabRefMaps = new Map(); // tabId -> Map<refString, { backendDOMNodeId, role, name }>

function groupTitleFor(session) {
  const clean = (session || "default").trim() || "default";
  return clean === "default" ? GROUP_PREFIX : `${GROUP_PREFIX}:${clean}`;
}

function sessionFromTitle(title) {
  if (title === GROUP_PREFIX) return "default";
  if (title && title.startsWith(`${GROUP_PREFIX}:`)) {
    return title.slice(GROUP_PREFIX.length + 1);
  }
  return null;
}

function groupColorFor(session) {
  const clean = (session || "default").trim() || "default";
  if (clean === "default") return "blue";
  let hash = 0;
  for (let i = 0; i < clean.length; i++) {
    hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
  }
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({
    color: connected ? "#16a34a" : "#6b7280",
  });
}

async function loadPort() {
  const stored = await chrome.storage.local.get(["port"]);
  const p = Number(stored.port);
  currentPort = Number.isFinite(p) && p >= 1 && p <= 65535 ? p : DEFAULT_PORT;
  return currentPort;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delays = [1000, 2000, 3000, 5000];
  const delay = delays[Math.min(reconnectAttempt, delays.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

async function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  await loadPort();
  const url = `ws://127.0.0.1:${currentPort}/ws`;

  try {
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      reconnectAttempt = 0;
      updateBadge(true);
      const manifest = chrome.runtime.getManifest();
      socket.send(
        JSON.stringify({
          type: "hello",
          version: manifest.version,
          userAgent: navigator.userAgent,
        })
      );

      stopPing();
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        }
      }, 20_000);
    };

    socket.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "request" && msg.id && msg.action) {
        try {
          const result = await handleAction(msg.action, msg.params || {});
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({ type: "response", id: msg.id, ok: true, result })
            );
          }
        } catch (err) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                type: "response",
                id: msg.id,
                ok: false,
                error: err?.message || String(err),
              })
            );
          }
        }
      }
    };

    socket.onclose = () => {
      if (ws === socket) {
        ws = null;
      }
      stopPing();
      updateBadge(false);
      scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose will handle cleanup and reconnect
    };
  } catch {
    updateBadge(false);
    scheduleReconnect();
  }
}

// Debugger & tab lifecycle cleanup
const fileChooserWaiters = new Map(); // tabId -> { resolve, reject, timer }
const tabDialogs = new Map(); // tabId -> Array<{ type, message, url, handled, ts }>
const recentOpenedTabs = new Map(); // openerTabId -> Array<{ tabId, url }>
const lastUserActiveTabByWindow = new Map(); // windowId -> tabId

function recordDialog(tabId, entry) {
  const list = tabDialogs.get(tabId) || [];
  list.push(entry);
  if (list.length > 10) list.shift();
  tabDialogs.set(tabId, list);
}

function drainDialogs(tabId) {
  const list = tabDialogs.get(tabId);
  if (!list || list.length === 0) return [];
  tabDialogs.delete(tabId);
  return list;
}

function drainOpenedTabs(tabId) {
  const list = recentOpenedTabs.get(tabId);
  if (!list || list.length === 0) return [];
  recentOpenedTabs.delete(tabId);
  return list;
}

async function isFantuanGroup(groupId) {
  if (groupId == null || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    return false;
  }
  try {
    const group = await chrome.tabGroups.get(groupId);
    return Boolean(sessionFromTitle(group?.title));
  } catch {
    return false;
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId;
  if (tabId == null) return;

  if (method === "Page.fileChooserOpened") {
    const waiter = fileChooserWaiters.get(tabId);
    if (waiter) {
      clearTimeout(waiter.timer);
      fileChooserWaiters.delete(tabId);
      waiter.resolve(params);
    }
    return;
  }

  if (method === "Page.javascriptDialogOpening") {
    const accept = true;
    recordDialog(tabId, {
      type: params?.type || "alert",
      message: String(params?.message || "").slice(0, 500),
      url: params?.url || "",
      handled: accept ? "accept" : "dismiss",
      ts: Date.now(),
    });
    chrome.debugger
      .sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept })
      .catch(() => {});
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId != null) {
    attachedTabs.delete(source.tabId);
    const waiter = fileChooserWaiters.get(source.tabId);
    if (waiter) {
      clearTimeout(waiter.timer);
      fileChooserWaiters.delete(source.tabId);
      waiter.reject(new Error("Debugger detached while waiting for file chooser"));
    }
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  chrome.tabs
    .get(tabId)
    .then(async (tab) => {
      if (!(await isFantuanGroup(tab.groupId))) {
        lastUserActiveTabByWindow.set(windowId, tabId);
      }
    })
    .catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab?.openerTabId == null || tab.id == null) return;
  chrome.tabs
    .get(tab.openerTabId)
    .then(async (opener) => {
      if (!opener || !(await isFantuanGroup(opener.groupId))) return;

      if (tab.groupId !== opener.groupId) {
        await chrome.tabs.group({
          tabIds: [tab.id],
          groupId: opener.groupId,
        });
      }

      const opened = recentOpenedTabs.get(opener.id) || [];
      opened.push({ tabId: tab.id, url: tab.pendingUrl || tab.url || "" });
      recentOpenedTabs.set(opener.id, opened);

      if (tab.active) {
        const prevUserTabId = lastUserActiveTabByWindow.get(tab.windowId);
        if (prevUserTabId != null && prevUserTabId !== tab.id) {
          await chrome.tabs.update(prevUserTabId, { active: true }).catch(() => {});
        }
      }
    })
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  tabRefMaps.delete(tabId);
  tabDialogs.delete(tabId);
  recentOpenedTabs.delete(tabId);
  for (const [winId, activeId] of lastUserActiveTabByWindow.entries()) {
    if (activeId === tabId) {
      lastUserActiveTabByWindow.delete(winId);
    }
  }
  for (const [sess, cur] of sessionCurrentTab.entries()) {
    if (cur === tabId) {
      sessionCurrentTab.delete(sess);
    }
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "fantuan-keepalive") {
    connectWebSocket();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("fantuan-keepalive", { periodInMinutes: 0.5 });
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("fantuan-keepalive", { periodInMinutes: 0.5 });
  connectWebSocket();
});

// Popup messaging
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "popup:status") {
      const sessions = await listSessions();
      sendResponse({
        connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
        port: currentPort,
        sessions,
      });
      return;
    }
    if (msg.type === "popup:set-port") {
      const nextPort = Number(msg.port);
      if (!Number.isFinite(nextPort) || nextPort < 1 || nextPort > 65535) {
        sendResponse({ ok: false, error: "Invalid port" });
        return;
      }
      await chrome.storage.local.set({ port: nextPort });
      currentPort = nextPort;
      if (ws) {
        ws.close();
        ws = null;
      }
      reconnectAttempt = 0;
      await connectWebSocket();
      sendResponse({ ok: true, port: currentPort });
      return;
    }
    if (msg.type === "popup:cleanup") {
      const result = await cleanupSession(msg.session, Boolean(msg.all));
      sendResponse({ ok: true, result });
      return;
    }
    if (msg.type === "popup:reconnect") {
      if (ws) {
        ws.close();
        ws = null;
      }
      reconnectAttempt = 0;
      await connectWebSocket();
      sendResponse({ ok: true });
      return;
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: err?.message || String(err) });
  });
  return true;
});

// ---------------- Tab Group & Session Helpers ----------------

async function findSessionGroup(session) {
  const title = groupTitleFor(session);
  const groups = await chrome.tabGroups.query({ title });
  return groups[0] || null;
}

async function getSessionTabs(session) {
  const group = await findSessionGroup(session);
  if (!group) return { group: null, tabs: [] };
  const tabs = await chrome.tabs.query({ groupId: group.id });
  return { group, tabs };
}

async function pickTargetWindowId(existingGroup) {
  if (existingGroup?.windowId != null) return existingGroup.windowId;
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const focused = windows.find((w) => w.focused);
  if (focused?.id != null) return focused.id;
  if (windows[0]?.id != null) return windows[0].id;
  const created = await chrome.windows.create({ focused: false, state: "normal" });
  return created.id;
}

async function createSessionTab(session, url = "about:blank") {
  const existingGroup = await findSessionGroup(session);
  const windowId = await pickTargetWindowId(existingGroup);

  // Create silently in background (active: false) so user's current tab is never disturbed
  const tab = await chrome.tabs.create({
    url,
    active: false,
    windowId,
  });

  let groupId;
  if (existingGroup) {
    groupId = await chrome.tabs.group({
      tabIds: [tab.id],
      groupId: existingGroup.id,
    });
  } else {
    groupId = await chrome.tabs.group({
      tabIds: [tab.id],
      createProperties: { windowId },
    });
    await chrome.tabGroups.update(groupId, {
      title: groupTitleFor(session),
      color: groupColorFor(session),
      collapsed: false,
    });
  }

  sessionCurrentTab.set(session, tab.id);
  return { tab, groupId };
}

async function resolveSessionTab(session, requestedTabId = null) {
  const { group, tabs } = await getSessionTabs(session);
  if (!group || tabs.length === 0) {
    throw new Error(
      `No open tabs in session "${session}". Run "open <url>" first.`
    );
  }

  if (requestedTabId != null) {
    const match = tabs.find((t) => t.id === Number(requestedTabId));
    if (!match) {
      throw new Error(
        `Tab ${requestedTabId} does not belong to session "${session}" (refusing to touch unmanaged tabs).`
      );
    }
    sessionCurrentTab.set(session, match.id);
    return { tab: match, groupId: group.id };
  }

  const rememberedId = sessionCurrentTab.get(session);
  const remembered = tabs.find((t) => t.id === rememberedId);
  if (remembered) {
    return { tab: remembered, groupId: group.id };
  }

  const fallback = tabs[tabs.length - 1];
  sessionCurrentTab.set(session, fallback.id);
  return { tab: fallback, groupId: group.id };
}

async function waitForTabComplete(tabId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return tab;
    }
    await sleep(120);
  }
  return chrome.tabs.get(tabId);
}

// ---------------- Debugger (CDP) Helpers ----------------

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    if (!String(err?.message || err).includes("Another debugger is already attached")) {
      throw err;
    }
  }
  attachedTabs.add(tabId);
  // Enable core domains silently; ignore if already enabled
  await Promise.allSettled([
    chrome.debugger.sendCommand({ tabId }, "Page.enable"),
    chrome.debugger.sendCommand({ tabId }, "DOM.enable"),
    chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
    chrome.debugger.sendCommand({ tabId }, "Accessibility.enable"),
  ]);
}

async function detachQuietly(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached or tab closed
  }
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("Debugger is not attached")) {
      attachedTabs.delete(tabId);
      await ensureAttached(tabId);
      return chrome.debugger.sendCommand({ tabId }, method, params);
    }
    throw err;
  }
}

async function evalInTab(tabId, expression) {
  const res = await cdp(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res?.exceptionDetails) {
    const text =
      res.exceptionDetails.exception?.description ||
      res.exceptionDetails.text ||
      "Evaluation failed";
    throw new Error(text);
  }
  return res?.result?.value;
}

async function getBackendNodeCenter(tabId, backendNodeId) {
  try {
    await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // ignore if element is not scrollable
  }
  const box = await cdp(tabId, "DOM.getBoxModel", { backendNodeId });
  const quad = box?.model?.content || box?.model?.border;
  if (!quad || quad.length < 8) {
    throw new Error("Element has no visible bounding box");
  }
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  return { x: Math.round(x), y: Math.round(y) };
}

async function waitForFileChooser(tabId, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const prev = fileChooserWaiters.get(tabId);
    if (prev) {
      clearTimeout(prev.timer);
      prev.reject(new Error("Superseded by another upload request"));
    }
    const timer = setTimeout(() => {
      fileChooserWaiters.delete(tabId);
      reject(new Error("Timed out waiting for file chooser dialog after clicking trigger"));
    }, timeoutMs);
    fileChooserWaiters.set(tabId, { resolve, reject, timer });
  });
}

async function resolveBackendNodeId(tabId, { ref, selector }) {
  if (ref) {
    const normalized = ref.startsWith("@") ? ref : `@${ref}`;
    const refMap = tabRefMaps.get(tabId);
    const entry = refMap?.get(normalized);
    if (!entry) {
      throw new Error(
        `Unknown ref "${normalized}". Run "snapshot" first to refresh element refs.`
      );
    }
    return entry.backendDOMNodeId;
  }

  const sel = selector || 'input[type="file"]';
  const doc = await cdp(tabId, "DOM.getDocument", { depth: 0 });
  const found = await cdp(tabId, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: sel,
  });
  if (!found?.nodeId) {
    throw new Error(`File input selector not found: ${sel}`);
  }
  const described = await cdp(tabId, "DOM.describeNode", {
    nodeId: found.nodeId,
  });
  return described.node.backendNodeId;
}

async function resolveTargetCoords(tabId, params) {
  if (typeof params.x === "number" && typeof params.y === "number") {
    return { x: params.x, y: params.y };
  }

  if (params.ref) {
    const normalized = params.ref.startsWith("@") ? params.ref : `@${params.ref}`;
    const refMap = tabRefMaps.get(tabId);
    const entry = refMap?.get(normalized);
    if (!entry) {
      throw new Error(
        `Unknown ref "${normalized}". Run "snapshot" first to refresh element refs.`
      );
    }
    return getBackendNodeCenter(tabId, entry.backendDOMNodeId);
  }

  if (params.selector) {
    const doc = await cdp(tabId, "DOM.getDocument", { depth: 0 });
    const found = await cdp(tabId, "DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: params.selector,
    });
    if (!found?.nodeId) {
      throw new Error(`Selector not found: ${params.selector}`);
    }
    const described = await cdp(tabId, "DOM.describeNode", {
      nodeId: found.nodeId,
    });
    return getBackendNodeCenter(tabId, described.node.backendNodeId);
  }

  throw new Error("Provide a @ref, --selector, or x y coordinates.");
}

async function clickAt(tabId, x, y, button = "left", clickCount = 1) {
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    clickCount,
  });
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    clickCount,
  });
}

// ---------------- Action Handlers ----------------

async function listSessions() {
  const allGroups = await chrome.tabGroups.query({});
  const result = [];
  for (const g of allGroups) {
    const session = sessionFromTitle(g.title);
    if (!session) continue;
    const tabs = await chrome.tabs.query({ groupId: g.id });
    const currentId = sessionCurrentTab.get(session) || null;
    result.push({
      session,
      groupId: g.id,
      title: g.title,
      color: g.color,
      collapsed: g.collapsed,
      windowId: g.windowId,
      tabCount: tabs.length,
      tabs: tabs.map((t) => ({
        id: t.id,
        title: t.title || "",
        url: t.url || "",
        current: t.id === currentId,
        attached: attachedTabs.has(t.id),
      })),
    });
  }
  return result;
}

async function cleanupSession(session, all = false) {
  const sessions = all ? (await listSessions()).map((s) => s.session) : [session];
  const closedTabs = [];
  for (const s of sessions) {
    const { tabs } = await getSessionTabs(s);
    for (const t of tabs) {
      await detachQuietly(t.id);
      tabRefMaps.delete(t.id);
      try {
        await chrome.tabs.remove(t.id);
        closedTabs.push(t.id);
      } catch {
        // already closed
      }
    }
    sessionCurrentTab.delete(s);
  }
  return { sessionsCleaned: sessions, closedTabCount: closedTabs.length, closedTabs };
}

const SNAPSHOT_STYLE_PROPS = [
  "display",
  "visibility",
  "opacity",
  "pointer-events",
  "cursor",
];

const AX_STATE_PROPS = new Set([
  "checked",
  "disabled",
  "expanded",
  "selected",
  "required",
  "readonly",
  "focused",
]);

function extractAxStates(node) {
  const states = [];
  for (const prop of node.properties || []) {
    if (!AX_STATE_PROPS.has(prop.name)) continue;
    const val = prop.value?.value;
    if (val === true || val === "mixed") {
      states.push(val === "mixed" ? `${prop.name}=mixed` : prop.name);
    }
  }
  return states;
}

async function captureLayoutIndex(tabId, viewport) {
  const layoutByBackendId = new Map();
  const pointerCandidates = [];

  try {
    const snap = await cdp(tabId, "DOMSnapshot.captureSnapshot", {
      computedStyles: SNAPSHOT_STYLE_PROPS,
    });
    const doc = snap?.documents?.[0];
    const strings = snap?.strings || [];
    if (!doc) return { layoutByBackendId, pointerCandidates };

    const backendIds = doc.nodes?.backendNodeId || [];
    const nodeNames = doc.nodes?.nodeName || [];
    const nodeIndices = doc.layout?.nodeIndex || [];
    const bounds = doc.layout?.bounds || [];
    const styles = doc.layout?.styles || [];
    const texts = doc.layout?.text || [];

    const scrollX = viewport?.scrollX || 0;
    const scrollY = viewport?.scrollY || 0;
    const vpWidth = viewport?.width || 1280;
    const vpHeight = viewport?.height || 800;

    for (let i = 0; i < nodeIndices.length; i++) {
      const nodeIdx = nodeIndices[i];
      const backendNodeId = backendIds[nodeIdx];
      const rect = bounds[i];
      if (!backendNodeId || !rect || rect.length < 4) continue;

      const [x, y, width, height] = rect;
      const styleIdx = styles[i] || [];
      const display = strings[styleIdx[0]] || "";
      const visibility = strings[styleIdx[1]] || "";
      const opacity = Number(strings[styleIdx[2]] ?? "1");
      const pointerEvents = strings[styleIdx[3]] || "";
      const cursor = strings[styleIdx[4]] || "";

      const visible =
        width > 1 &&
        height > 1 &&
        display !== "none" &&
        visibility !== "hidden" &&
        visibility !== "collapse" &&
        !(Number.isFinite(opacity) && opacity <= 0.01);

      const inViewport =
        visible &&
        x + width > scrollX &&
        x < scrollX + vpWidth &&
        y + height > scrollY &&
        y < scrollY + vpHeight;

      const info = {
        box: {
          x: Math.round(x - scrollX),
          y: Math.round(y - scrollY),
          width: Math.round(width),
          height: Math.round(height),
        },
        visible,
        inViewport,
        cursorPointer: cursor === "pointer" && pointerEvents !== "none",
      };

      const prev = layoutByBackendId.get(backendNodeId);
      if (!prev || (!prev.visible && info.visible)) {
        layoutByBackendId.set(backendNodeId, info);
      }

      if (
        info.inViewport &&
        info.cursorPointer &&
        width < vpWidth * 0.9 &&
        height < vpHeight * 0.6
      ) {
        const tag = String(strings[nodeNames[nodeIdx]] || "").toLowerCase();
        const text = String(strings[texts[i]] || "").trim();
        if (text && tag !== "html" && tag !== "body") {
          pointerCandidates.push({
            backendDOMNodeId: backendNodeId,
            role: "clickable",
            name: text.slice(0, 160),
            box: info.box,
            inViewport: true,
          });
        }
      }
    }
  } catch {
    // Fallback gracefully to pure AXTree when DOMSnapshot is unavailable
  }

  return { layoutByBackendId, pointerCandidates };
}

async function getViewportMeta(tabId) {
  try {
    return await evalInTab(
      tabId,
      `(() => {
        const width = window.innerWidth || document.documentElement.clientWidth || 0;
        const height = window.innerHeight || document.documentElement.clientHeight || 0;
        const scrollX = Math.round(window.scrollX || 0);
        const scrollY = Math.round(window.scrollY || 0);
        const scrollHeight = Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0,
          height
        );
        return {
          width,
          height,
          scrollX,
          scrollY,
          pixelsAbove: Math.max(0, scrollY),
          pixelsBelow: Math.max(0, Math.round(scrollHeight - (scrollY + height))),
        };
      })()`
    );
  } catch {
    return null;
  }
}

async function buildSnapshot(
  tabId,
  { interactiveOnly = false, viewportOnly = false, limit = 150 } = {}
) {
  const [tree, viewport] = await Promise.all([
    cdp(tabId, "Accessibility.getFullAXTree"),
    getViewportMeta(tabId),
  ]);
  const { layoutByBackendId, pointerCandidates } = await captureLayoutIndex(
    tabId,
    viewport
  );
  const hasLayout = layoutByBackendId.size > 0;
  const nodes = tree?.nodes || [];
  const candidates = [];
  const seenBackendIds = new Set();

  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value || "";
    const name = (node.name?.value || "").trim();
    const backendDOMNodeId = node.backendDOMNodeId;
    if (!backendDOMNodeId) continue;

    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isContent = CONTENT_ROLES.has(role) && Boolean(name);

    if (interactiveOnly && !isInteractive) continue;
    if (!isInteractive && !isContent) continue;
    if (!name && role !== "textbox" && role !== "searchbox" && role !== "combobox") {
      continue;
    }

    const layout = layoutByBackendId.get(backendDOMNodeId);
    if (hasLayout && layout && !layout.visible) continue;
    if (viewportOnly && hasLayout && (!layout || !layout.inViewport)) continue;

    seenBackendIds.add(backendDOMNodeId);
    const valueProp = node.value?.value;
    const states = extractAxStates(node);
    const item = {
      role,
      name: name.slice(0, 160),
      backendDOMNodeId,
      inViewport: layout ? layout.inViewport : true,
      box: layout?.box || null,
    };
    if (valueProp !== undefined && valueProp !== "") {
      item.value = String(valueProp).slice(0, 120);
    }
    if (states.length > 0) {
      item.states = states;
    }
    candidates.push(item);
  }

  // Supplement non-semantic cursor:pointer interactive elements missed by AXTree
  let pointerAdded = 0;
  for (const cand of pointerCandidates) {
    if (pointerAdded >= 30) break;
    if (seenBackendIds.has(cand.backendDOMNodeId)) continue;
    seenBackendIds.add(cand.backendDOMNodeId);
    candidates.push(cand);
    pointerAdded++;
  }

  // When exceeding limit, prioritize in-viewport elements while preserving document order
  let selected = candidates;
  if (candidates.length > limit) {
    const inVp = candidates.filter((c) => c.inViewport);
    if (inVp.length >= limit) {
      selected = inVp.slice(0, limit);
    } else {
      let offVpBudget = limit - inVp.length;
      selected = candidates.filter((c) => {
        if (c.inViewport) return true;
        if (offVpBudget > 0) {
          offVpBudget--;
          return true;
        }
        return false;
      });
    }
  }

  const refMap = new Map();
  const items = selected.map((c, idx) => {
    const ref = `@${idx + 1}`;
    const item = {
      ref,
      role: c.role,
      name: c.name,
      backendDOMNodeId: c.backendDOMNodeId,
      inViewport: c.inViewport,
    };
    if (c.value !== undefined) item.value = c.value;
    if (c.states) item.states = c.states;
    refMap.set(ref, {
      backendDOMNodeId: c.backendDOMNodeId,
      role: c.role,
      name: c.name,
      box: c.box,
      inViewport: c.inViewport,
    });
    return item;
  });

  tabRefMaps.set(tabId, refMap);
  const tab = await chrome.tabs.get(tabId);
  const dialogs = drainDialogs(tabId);
  return {
    tabId,
    url: tab.url || "",
    title: tab.title || "",
    ...(viewport ? { viewport } : {}),
    count: items.length,
    items,
    ...(dialogs.length ? { dialogs } : {}),
  };
}

async function summarizePostAction(tabId, beforeUrl, beforeTitle) {
  await sleep(80);
  const summary = {};
  try {
    const after = await chrome.tabs.get(tabId);
    if (after.url && after.url !== beforeUrl) {
      summary.url = after.url;
      summary.navigated = true;
    }
    if (after.title && after.title !== beforeTitle) {
      summary.title = after.title;
    }
  } catch {
    // tab may have closed during action
  }
  const openedTabs = drainOpenedTabs(tabId);
  if (openedTabs.length > 0) {
    summary.openedTabs = openedTabs;
  }
  const dialogs = drainDialogs(tabId);
  if (dialogs.length > 0) {
    summary.dialogs = dialogs;
  }
  return summary;
}

async function renderAnnotationOverlay(tabId) {
  let refMap = tabRefMaps.get(tabId);
  if (!refMap || refMap.size === 0) {
    await buildSnapshot(tabId, { interactiveOnly: true, viewportOnly: true });
    refMap = tabRefMaps.get(tabId);
  }
  const boxes = [];
  for (const [ref, entry] of (refMap || new Map()).entries()) {
    if (!entry.box || !entry.inViewport) continue;
    boxes.push({ ref, ...entry.box });
  }
  const boxesJson = JSON.stringify(boxes);
  await evalInTab(
    tabId,
    `(() => {
      const id = "__fantuan_annotate_overlay__";
      document.getElementById(id)?.remove();
      const root = document.createElement("div");
      root.id = id;
      root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
      const palette = ["#2563eb","#dc2626","#16a34a","#9333ea","#ea580c","#0891b2"];
      const boxes = ${boxesJson};
      boxes.forEach((b, i) => {
        const color = palette[i % palette.length];
        const box = document.createElement("div");
        box.style.cssText = "position:fixed;box-sizing:border-box;border:2px solid " + color +
          ";left:" + b.x + "px;top:" + b.y + "px;width:" + b.width + "px;height:" + b.height + "px;";
        const tag = document.createElement("span");
        tag.textContent = b.ref;
        tag.style.cssText = "position:absolute;left:-2px;top:-16px;background:" + color +
          ";color:#fff;font:bold 11px/14px monospace;padding:1px 4px;border-radius:2px;white-space:nowrap;";
        box.appendChild(tag);
        root.appendChild(box);
      });
      (document.documentElement || document.body).appendChild(root);
      return boxes.length;
    })()`
  );
  return boxes.length;
}

async function removeAnnotationOverlay(tabId) {
  await evalInTab(
    tabId,
    `document.getElementById("__fantuan_annotate_overlay__")?.remove()`
  ).catch(() => {});
}

async function dispatchKeyCombo(tabId, combo) {
  const parts = String(combo).split("+").map((p) => p.trim()).filter(Boolean);
  let modifiers = 0;
  let mainKey = parts[parts.length - 1] || "";

  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase();
    if (lower === "alt" || lower === "option") modifiers |= 1;
    else if (lower === "ctrl" || lower === "control") modifiers |= 2;
    else if (lower === "meta" || lower === "cmd" || lower === "command") modifiers |= 4;
    else if (lower === "shift") modifiers |= 8;
  }

  const def = KEY_DEFINITIONS[mainKey] || {
    key: mainKey,
    code: mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey,
    keyCode: mainKey.length === 1 ? mainKey.toUpperCase().charCodeAt(0) : 0,
    text: mainKey.length === 1 && modifiers === 0 ? mainKey : undefined,
  };

  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: def.text ? "keyDown" : "rawKeyDown",
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
    text: def.text,
  });
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  });
}

async function handleAction(action, params) {
  const session = (params.session || "default").trim() || "default";

  switch (action) {
    case "sessions": {
      return { sessions: await listSessions() };
    }

    case "open":
    case "new_tab": {
      const url = params.url || "about:blank";
      const { tab, groupId } = await createSessionTab(session, url);
      const loaded = await waitForTabComplete(tab.id, params.timeoutMs || 15_000);
      return {
        session,
        groupId,
        tabId: loaded.id,
        url: loaded.url || url,
        title: loaded.title || "",
      };
    }

    case "goto": {
      const url = params.url;
      if (!url) throw new Error("Missing url");
      const { tabs } = await getSessionTabs(session);
      let tabId;
      let groupId;
      if (tabs.length === 0) {
        const created = await createSessionTab(session, url);
        tabId = created.tab.id;
        groupId = created.groupId;
      } else {
        const resolved = await resolveSessionTab(session, params.tabId);
        tabId = resolved.tab.id;
        groupId = resolved.groupId;
        await chrome.tabs.update(tabId, { url });
      }
      tabRefMaps.delete(tabId);
      const loaded = await waitForTabComplete(tabId, params.timeoutMs || 15_000);
      return {
        session,
        groupId,
        tabId: loaded.id,
        url: loaded.url || url,
        title: loaded.title || "",
      };
    }

    case "tabs": {
      const { group, tabs } = await getSessionTabs(session);
      const currentId = sessionCurrentTab.get(session) || null;
      return {
        session,
        groupId: group?.id || null,
        tabs: tabs.map((t) => ({
          id: t.id,
          title: t.title || "",
          url: t.url || "",
          current: t.id === currentId,
          attached: attachedTabs.has(t.id),
        })),
      };
    }

    case "use": {
      const { tab, groupId } = await resolveSessionTab(session, params.tabId);
      return {
        session,
        groupId,
        tabId: tab.id,
        url: tab.url || "",
        title: tab.title || "",
      };
    }

    case "focus": {
      const { tab, groupId } = await resolveSessionTab(session, params.tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      return {
        session,
        groupId,
        tabId: tab.id,
        focused: true,
        url: tab.url || "",
        title: tab.title || "",
      };
    }

    case "close": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      await detachQuietly(tab.id);
      tabRefMaps.delete(tab.id);
      await chrome.tabs.remove(tab.id);
      return { session, closedTabId: tab.id };
    }

    case "cleanup": {
      return cleanupSession(session, Boolean(params.all));
    }

    case "info": {
      const { tab, groupId } = await resolveSessionTab(session, params.tabId);
      const meta = await evalInTab(
        tab.id,
        `({ readyState: document.readyState, width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY })`
      );
      return {
        session,
        groupId,
        tabId: tab.id,
        url: tab.url || "",
        title: tab.title || "",
        ...meta,
      };
    }

    case "snapshot": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      return buildSnapshot(tab.id, {
        interactiveOnly: Boolean(params.interactiveOnly),
        viewportOnly: Boolean(params.viewportOnly),
        limit: params.limit || 150,
      });
    }

    case "click": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const coords = await resolveTargetCoords(tab.id, params);
      await clickAt(tab.id, coords.x, coords.y, params.button || "left", params.clickCount || 1);
      const outcome = await summarizePostAction(tab.id, tab.url, tab.title);
      return { tabId: tab.id, clicked: coords, ...outcome };
    }

    case "hover": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const coords = await resolveTargetCoords(tab.id, params);
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: coords.x,
        y: coords.y,
      });
      return { tabId: tab.id, hovered: coords };
    }

    case "select": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      if (params.value === undefined || params.value === null) {
        throw new Error("Missing option value or label to select");
      }
      const backendNodeId = await resolveBackendNodeId(tab.id, {
        ref: params.ref,
        selector: params.selector,
      });
      const resolved = await cdp(tab.id, "DOM.resolveNode", { backendNodeId });
      const objectId = resolved?.object?.objectId;
      if (!objectId) {
        throw new Error("Unable to resolve target <select> element");
      }
      const call = await cdp(tab.id, "Runtime.callFunctionOn", {
        objectId,
        arguments: [{ value: String(params.value) }],
        returnByValue: true,
        functionDeclaration: `function(target) {
          if (!this || this.tagName !== "SELECT") {
            throw new Error("Target element is not a <select>");
          }
          const opts = Array.from(this.options || []);
          const match =
            opts.find((o) => o.value === target) ||
            opts.find((o) => (o.textContent || "").trim() === target) ||
            opts.find((o) => (o.textContent || "").trim().toLowerCase() === target.toLowerCase());
          if (!match) {
            throw new Error("Option not found: " + target);
          }
          this.value = match.value;
          match.selected = true;
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          return { value: match.value, label: (match.textContent || "").trim() };
        }`,
      });
      if (call?.exceptionDetails) {
        const text =
          call.exceptionDetails.exception?.description ||
          call.exceptionDetails.text ||
          "Select failed";
        throw new Error(text);
      }
      return { tabId: tab.id, selected: call?.result?.value || null };
    }

    case "type":
    case "fill": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const text = params.text ?? "";
      if (params.ref || params.selector) {
        try {
          const backendNodeId = await resolveBackendNodeId(tab.id, {
            ref: params.ref,
            selector: params.selector,
          });
          await cdp(tab.id, "DOM.focus", { backendNodeId });
        } catch {
          // fallback to coordinate click below
        }
      }
      if (params.ref || params.selector || (typeof params.x === "number" && typeof params.y === "number")) {
        const coords = await resolveTargetCoords(tab.id, params);
        await clickAt(tab.id, coords.x, coords.y);
      }
      if (action === "fill" || params.clear) {
        // Use platform-appropriate select-all (Ctrl+A on macOS moves cursor to line start instead of selecting all)
        const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent || "");
        await dispatchKeyCombo(tab.id, isMac ? "Meta+a" : "Control+a");
        await dispatchKeyCombo(tab.id, "Backspace");
      }
      if (text.length > 0) {
        await cdp(tab.id, "Input.insertText", { text: String(text) });
      }
      return { tabId: tab.id, typedLength: String(text).length };
    }

    case "press": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      await dispatchKeyCombo(tab.id, params.key);
      const outcome = await summarizePostAction(tab.id, tab.url, tab.title);
      return { tabId: tab.id, key: params.key, ...outcome };
    }

    case "scroll": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const vp = await evalInTab(
        tab.id,
        `({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) })`
      );
      const x = typeof params.x === "number" ? params.x : vp?.x || 400;
      const y = typeof params.y === "number" ? params.y : vp?.y || 300;
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: Number(params.dx || 0),
        deltaY: Number(params.dy || 500),
      });
      await sleep(100);
      const pos = await evalInTab(tab.id, `({ scrollX: window.scrollX, scrollY: window.scrollY })`);
      return { tabId: tab.id, ...pos };
    }

    case "text": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const maxChars = Number(params.maxChars || 12_000);
      const selectorJson = params.selector ? JSON.stringify(params.selector) : "null";
      const text = await evalInTab(
        tab.id,
        `(() => {
          const sel = ${selectorJson};
          const el = sel ? document.querySelector(sel) : document.body;
          if (!el) return "";
          return (el.innerText || el.textContent || "").trim();
        })()`
      );
      const str = String(text || "");
      return {
        tabId: tab.id,
        url: tab.url || "",
        title: tab.title || "",
        truncated: str.length > maxChars,
        text: str.slice(0, maxChars),
      };
    }

    case "eval": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const value = await evalInTab(tab.id, params.expression);
      return { tabId: tab.id, value };
    }

    case "screenshot": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const captureParams = {
        format: "png",
        fromSurface: true,
      };
      if (params.fullPage) {
        captureParams.captureBeyondViewport = true;
      }
      let annotatedCount = 0;
      if (params.annotate) {
        annotatedCount = await renderAnnotationOverlay(tab.id);
      }
      try {
        const res = await cdp(tab.id, "Page.captureScreenshot", captureParams);
        return {
          tabId: tab.id,
          url: tab.url || "",
          title: tab.title || "",
          ...(params.annotate ? { annotatedCount } : {}),
          dataBase64: res.data,
        };
      } finally {
        if (params.annotate) {
          await removeAnnotationOverlay(tab.id);
        }
      }
    }

    case "wait": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const timeoutMs = Number(params.timeoutMs || 10_000);
      if (params.selector) {
        const selJson = JSON.stringify(params.selector);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const exists = await evalInTab(tab.id, `Boolean(document.querySelector(${selJson}))`);
          if (exists) return { tabId: tab.id, matched: true, selector: params.selector };
          await sleep(150);
        }
        throw new Error(`Timed out waiting for selector: ${params.selector}`);
      }
      if (params.text) {
        const textJson = JSON.stringify(params.text);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const exists = await evalInTab(
            tab.id,
            `Boolean((document.body?.innerText || "").includes(${textJson}))`
          );
          if (exists) return { tabId: tab.id, matched: true, text: params.text };
          await sleep(150);
        }
        throw new Error(`Timed out waiting for text: ${params.text}`);
      }
      const ms = Number(params.ms || 1000);
      await sleep(ms);
      return { tabId: tab.id, waitedMs: ms };
    }

    case "back": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      await chrome.tabs.goBack(tab.id);
      const loaded = await waitForTabComplete(tab.id);
      return { tabId: loaded.id, url: loaded.url, title: loaded.title };
    }

    case "forward": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      await chrome.tabs.goForward(tab.id);
      const loaded = await waitForTabComplete(tab.id);
      return { tabId: loaded.id, url: loaded.url, title: loaded.title };
    }

    case "reload": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      await chrome.tabs.reload(tab.id);
      const loaded = await waitForTabComplete(tab.id);
      return { tabId: loaded.id, url: loaded.url, title: loaded.title };
    }

    case "upload": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const files = Array.isArray(params.files) ? params.files : [];
      if (files.length === 0) {
        throw new Error("Missing files to upload");
      }

      if (params.trigger) {
        await cdp(tab.id, "Page.setInterceptFileChooserDialog", { enabled: true });
        try {
          const chooserPromise = waitForFileChooser(tab.id, params.timeoutMs || 8_000);
          const triggerParams = params.trigger.startsWith("@")
            ? { ref: params.trigger }
            : { selector: params.trigger };
          const coords = await resolveTargetCoords(tab.id, triggerParams);
          await clickAt(tab.id, coords.x, coords.y);
          const event = await chooserPromise;
          if (!event?.backendNodeId) {
            throw new Error("File chooser opened without a backendNodeId");
          }
          await cdp(tab.id, "DOM.setFileInputFiles", {
            files,
            backendNodeId: event.backendNodeId,
          });
          return {
            tabId: tab.id,
            mode: "intercept",
            trigger: params.trigger,
            files,
          };
        } finally {
          await cdp(tab.id, "Page.setInterceptFileChooserDialog", {
            enabled: false,
          }).catch(() => {});
        }
      }

      const backendNodeId = await resolveBackendNodeId(tab.id, {
        ref: params.ref,
        selector: params.selector,
      });
      await cdp(tab.id, "DOM.setFileInputFiles", {
        files,
        backendNodeId,
      });
      return {
        tabId: tab.id,
        mode: "direct",
        files,
      };
    }

    case "cdp": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const res = await cdp(tab.id, params.method, params.cdpParams || {});
      return { tabId: tab.id, result: res };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// Kick off connection & alarm immediately when service worker boots
chrome.alarms.create("fantuan-keepalive", { periodInMinutes: 0.5 });
connectWebSocket();
