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

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Page.fileChooserOpened" && source?.tabId != null) {
    const waiter = fileChooserWaiters.get(source.tabId);
    if (waiter) {
      clearTimeout(waiter.timer);
      fileChooserWaiters.delete(source.tabId);
      waiter.resolve(params);
    }
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

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  tabRefMaps.delete(tabId);
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

async function buildSnapshot(tabId, { interactiveOnly = false, limit = 150 } = {}) {
  const tree = await cdp(tabId, "Accessibility.getFullAXTree");
  const nodes = tree?.nodes || [];
  const refMap = new Map();
  const items = [];
  let counter = 0;

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

    counter++;
    const ref = `@${counter}`;
    const valueProp = node.value?.value;
    const item = {
      ref,
      role,
      name: name.slice(0, 160),
      backendDOMNodeId,
    };
    if (valueProp !== undefined && valueProp !== "") {
      item.value = String(valueProp).slice(0, 120);
    }

    refMap.set(ref, { backendDOMNodeId, role, name: item.name });
    items.push(item);
    if (items.length >= limit) break;
  }

  tabRefMaps.set(tabId, refMap);
  const tab = await chrome.tabs.get(tabId);
  return {
    tabId,
    url: tab.url || "",
    title: tab.title || "",
    count: items.length,
    items,
  };
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
        limit: params.limit || 150,
      });
    }

    case "click": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const coords = await resolveTargetCoords(tab.id, params);
      await clickAt(tab.id, coords.x, coords.y, params.button || "left", params.clickCount || 1);
      return { tabId: tab.id, clicked: coords };
    }

    case "type":
    case "fill": {
      const { tab } = await resolveSessionTab(session, params.tabId);
      const text = params.text ?? "";
      if (params.ref || params.selector || (typeof params.x === "number" && typeof params.y === "number")) {
        const coords = await resolveTargetCoords(tab.id, params);
        await clickAt(tab.id, coords.x, coords.y);
      }
      if (action === "fill" || params.clear) {
        // Select all & delete (works on both macOS & Linux/Windows)
        await dispatchKeyCombo(tab.id, "Meta+a");
        await dispatchKeyCombo(tab.id, "Control+a");
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
      return { tabId: tab.id, key: params.key };
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
      const res = await cdp(tab.id, "Page.captureScreenshot", captureParams);
      return {
        tabId: tab.id,
        url: tab.url || "",
        title: tab.title || "",
        dataBase64: res.data,
      };
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
