const statusBadge = document.getElementById("statusBadge");
const portInput = document.getElementById("portInput");
const savePortBtn = document.getElementById("savePortBtn");
const sessionsList = document.getElementById("sessionsList");
const reconnectBtn = document.getElementById("reconnectBtn");
const cleanupAllBtn = document.getElementById("cleanupAllBtn");

function renderSessions(sessions) {
  sessionsList.innerHTML = "";
  if (!sessions || sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No active agent Tab Groups";
    sessionsList.appendChild(empty);
    return;
  }

  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "session-item";

    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.innerHTML = `<strong>${s.title}</strong><div class="session-sub">${s.tabCount} tab(s)</div>`;

    const btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Close";
    btn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "popup:cleanup", session: s.session });
      refresh();
    });

    item.appendChild(meta);
    item.appendChild(btn);
    sessionsList.appendChild(item);
  }
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "popup:status" });
  if (!res) return;
  statusBadge.textContent = res.connected ? "Connected" : "Disconnected";
  statusBadge.className = res.connected ? "badge connected" : "badge";
  if (res.port) portInput.value = res.port;
  renderSessions(res.sessions);
}

savePortBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "popup:set-port",
    port: Number(portInput.value),
  });
  setTimeout(refresh, 300);
});

reconnectBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup:reconnect" });
  setTimeout(refresh, 300);
});

cleanupAllBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup:cleanup", all: true });
  refresh();
});

refresh();
