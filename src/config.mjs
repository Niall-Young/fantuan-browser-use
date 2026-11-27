import os from "node:os";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 19222;
export const DEFAULT_SESSION = "default";
export const REQUEST_TIMEOUT_MS = 35_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_EXTENSION_WAIT_MS = 6_500;

export function getPort() {
  const raw = process.env.FANTUAN_BROWSER_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid FANTUAN_BROWSER_PORT: ${raw}`);
  }
  return parsed;
}

export function getIdleTimeoutMs() {
  const raw = process.env.FANTUAN_BROWSER_IDLE_MS;
  if (raw == null || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off") {
    return 0;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid FANTUAN_BROWSER_IDLE_MS: ${raw}`);
  }
  return parsed;
}

export function getStateDir() {
  return (
    process.env.FANTUAN_BROWSER_STATE_DIR ||
    path.join(os.homedir(), ".fantuan-browser")
  );
}

export function getPidFile() {
  return path.join(getStateDir(), `daemon-${getPort()}.pid`);
}

export function getLogFile() {
  return path.join(getStateDir(), `daemon-${getPort()}.log`);
}

export function getDefaultSession() {
  return process.env.FANTUAN_BROWSER_SESSION || DEFAULT_SESSION;
}
