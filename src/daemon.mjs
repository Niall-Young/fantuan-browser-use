import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HOST,
  REQUEST_TIMEOUT_MS,
  getPidFile,
  getPort,
  getStateDir,
} from "./config.mjs";
import { attachWebSocketServer, isExtensionOrigin } from "./ws-server.mjs";

function readJsonBody(req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function createDaemonServer(options = {}) {
  const {
    host = DEFAULT_HOST,
    port = getPort(),
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    allowOrigin = isExtensionOrigin,
    writePid = false,
  } = options;

  let extensionConn = null;
  let extensionMeta = null;
  let connectedAt = null;
  const startedAt = new Date().toISOString();
  const pending = new Map();

  function failAllPending(reason) {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function sendToExtension(action, params = {}, timeoutMs = requestTimeoutMs) {
    if (!extensionConn || extensionConn.closed) {
      return Promise.reject(
        new Error(
          "Chrome extension is not connected. Open Chrome and ensure the Fantuan Browser extension is loaded and enabled."
        )
      );
    }

    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(`Timed out waiting for extension response to "${action}"`)
        );
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });
      const ok = extensionConn.sendJson({
        type: "request",
        id,
        action,
        params,
      });
      if (!ok) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error("Failed to send message to Chrome extension"));
      }
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        host,
        port,
        startedAt,
        extensionConnected: Boolean(extensionConn && !extensionConn.closed),
        extensionConnectedAt: connectedAt,
        extension: extensionMeta,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/shutdown") {
      sendJson(res, 200, { ok: true, shuttingDown: true });
      setTimeout(() => {
        close().catch(() => {});
      }, 20);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/command") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }

      const { action, params = {}, timeoutMs } = body || {};
      if (!action || typeof action !== "string") {
        sendJson(res, 400, { ok: false, error: "Missing 'action' string" });
        return;
      }

      try {
        const result = await sendToExtension(
          action,
          params,
          typeof timeoutMs === "number" ? timeoutMs : requestTimeoutMs
        );
        sendJson(res, 200, { ok: true, result });
      } catch (err) {
        const status = err.message.includes("not connected") ? 503 : 500;
        sendJson(res, status, { ok: false, error: err.message });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  });

  attachWebSocketServer(server, {
    path: "/ws",
    allowOrigin,
    onConnection(conn) {
      if (extensionConn && !extensionConn.closed) {
        extensionConn.close(1000, "Replaced by newer extension connection");
      }
      extensionConn = conn;
      connectedAt = new Date().toISOString();
      extensionMeta = { origin: conn.origin };

      conn.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }

        if (msg.type === "hello") {
          extensionMeta = {
            origin: conn.origin,
            version: msg.version || null,
            userAgent: msg.userAgent || null,
          };
          conn.sendJson({ type: "welcome", pid: process.pid, port });
          return;
        }

        if (msg.type === "ping") {
          conn.sendJson({ type: "pong", ts: Date.now() });
          return;
        }

        if (msg.type === "response" && msg.id) {
          const entry = pending.get(msg.id);
          if (!entry) return;
          clearTimeout(entry.timer);
          pending.delete(msg.id);
          if (msg.ok) {
            entry.resolve(msg.result);
          } else {
            entry.reject(new Error(msg.error || "Unknown extension error"));
          }
        }
      });

      conn.on("close", () => {
        if (extensionConn === conn) {
          extensionConn = null;
          connectedAt = null;
          extensionMeta = null;
          failAllPending("Chrome extension disconnected");
        }
      });
    },
  });

  async function start() {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    if (writePid) {
      fs.mkdirSync(getStateDir(), { recursive: true });
      fs.writeFileSync(getPidFile(), String(process.pid), "utf8");
    }

    const addr = server.address();
    return {
      host,
      port: typeof addr === "object" && addr ? addr.port : port,
    };
  }

  async function close() {
    failAllPending("Daemon shutting down");
    if (extensionConn && !extensionConn.closed) {
      extensionConn.close(1001, "Daemon shutting down");
    }
    if (writePid) {
      try {
        fs.unlinkSync(getPidFile());
      } catch {
        // ignore missing pid file
      }
    }
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    server,
    start,
    close,
    get isExtensionConnected() {
      return Boolean(extensionConn && !extensionConn.closed);
    },
  };
}

const isMain =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  const daemon = createDaemonServer({ writePid: true });
  daemon
    .start()
    .then(({ host, port }) => {
      console.log(
        `[fantuan-browser] daemon listening on http://${host}:${port} (ws://${host}:${port}/ws)`
      );
    })
    .catch((err) => {
      console.error(`[fantuan-browser] failed to start daemon: ${err.message}`);
      process.exit(1);
    });

  const shutdown = () => {
    daemon.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
