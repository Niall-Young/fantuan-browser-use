import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HOST,
  REQUEST_TIMEOUT_MS,
  getLogFile,
  getPort,
  getStateDir,
} from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.join(__dirname, "daemon.mjs");

function baseUrl(port = getPort()) {
  return `http://${DEFAULT_HOST}:${port}`;
}

export async function getHealth(port = getPort()) {
  try {
    const res = await fetch(`${baseUrl(port)}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function startDaemon(port = getPort()) {
  const existing = await getHealth(port);
  if (existing?.ok) return existing;

  fs.mkdirSync(getStateDir(), { recursive: true });
  const logPath = getLogFile();
  const logFd = fs.openSync(logPath, "a");

  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      FANTUAN_BROWSER_PORT: String(port),
    },
  });
  child.unref();
  fs.closeSync(logFd);

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const health = await getHealth(port);
    if (health?.ok) return health;
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error(
    `Failed to start fantuan-browser daemon on port ${port}. Check log: ${logPath}`
  );
}

export async function stopDaemon(port = getPort()) {
  const existing = await getHealth(port);
  if (!existing?.ok) return { stopped: false, reason: "not running" };

  try {
    await fetch(`${baseUrl(port)}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // ignore connection close during shutdown
  }

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const h = await getHealth(port);
    if (!h) return { stopped: true };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { stopped: true };
}

export async function sendCommand(action, params = {}, options = {}) {
  const port = options.port || getPort();
  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;

  await startDaemon(port);

  const res = await fetch(`${baseUrl(port)}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, params, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 2000),
  });

  const data = await res.json().catch(() => ({
    ok: false,
    error: `HTTP ${res.status}`,
  }));

  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Command "${action}" failed (HTTP ${res.status})`);
  }

  return data.result;
}
