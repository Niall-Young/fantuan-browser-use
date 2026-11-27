import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, "..", "package.json");

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 19222;
export const DEFAULT_SESSION = "default";
export const DEFAULT_REPO = "Niall-Young/fantuan-browser-use";
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

export function getInstallDir() {
  return (
    process.env.FANTUAN_BROWSER_APP_DIR ||
    path.join(getStateDir(), "app")
  );
}

export function getRepo() {
  if (process.env.FANTUAN_BROWSER_REPO) {
    return process.env.FANTUAN_BROWSER_REPO.trim();
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
    if (typeof pkg.repository === "string" && pkg.repository.includes("/")) {
      return pkg.repository.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    }
    if (pkg.repository?.url) {
      const m = String(pkg.repository.url).match(/github\.com[/:]([^/]+\/[^/.]+)/);
      if (m) return m[1];
    }
  } catch {
    // fallback to default
  }
  return DEFAULT_REPO;
}

export function getLocalVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
