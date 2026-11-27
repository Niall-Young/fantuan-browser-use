import os from "node:os";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 19222;
export const DEFAULT_SESSION = "default";
export const REQUEST_TIMEOUT_MS = 35_000;

export function getPort() {
  const raw = process.env.FANTUAN_BROWSER_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid FANTUAN_BROWSER_PORT: ${raw}`);
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
