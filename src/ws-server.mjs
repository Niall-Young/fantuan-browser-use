import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB (safe for full-page screenshots)

function encodeFrame(opcode, payloadBuffer) {
  const payload = Buffer.isBuffer(payloadBuffer)
    ? payloadBuffer
    : Buffer.from(payloadBuffer ?? "");
  const len = payload.length;

  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.origin = req.headers.origin || "";
    this.closed = false;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._handleClose());
    socket.on("error", (err) => {
      if (!this.closed) {
        this.emit("error", err);
      }
      this._handleClose();
    });
  }

  sendText(text) {
    if (this.closed || this.socket.destroyed) return false;
    this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
    return true;
  }

  sendJson(obj) {
    return this.sendText(JSON.stringify(obj));
  }

  ping(data = "") {
    if (this.closed || this.socket.destroyed) return false;
    this.socket.write(encodeFrame(0x9, Buffer.from(data)));
    return true;
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    try {
      const reasonBuf = Buffer.from(reason, "utf8");
      const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      if (!this.socket.destroyed) {
        this.socket.end(encodeFrame(0x8, payload));
      }
    } catch {
      this.socket.destroy();
    }
    this.emit("close", code, reason);
  }

  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", 1006, "");
  }

  _onData(chunk) {
    this._buffer =
      this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

    while (this._buffer.length >= 2) {
      const byte0 = this._buffer[0];
      const byte1 = this._buffer[1];
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const bigLen = this._buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_PAYLOAD_BYTES)) {
          this.close(1009, "Payload too large");
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_PAYLOAD_BYTES) {
        this.close(1009, "Payload too large");
        return;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (this._buffer.length < totalLen) return;

      let maskKey = null;
      if (masked) {
        maskKey = this._buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.allocUnsafe(payloadLen);
      this._buffer.copy(payload, 0, offset, offset + payloadLen);
      this._buffer = this._buffer.subarray(totalLen);

      if (maskKey) {
        for (let i = 0; i < payloadLen; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    // Control frames
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      this.close(code, reason);
      return;
    }
    if (opcode === 0x9) {
      if (!this.closed && !this.socket.destroyed) {
        this.socket.write(encodeFrame(0xA, payload));
      }
      return;
    }
    if (opcode === 0xA) {
      this.emit("pong", payload);
      return;
    }

    // Data frames (text=0x1, binary=0x2, continuation=0x0)
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) {
        this._emitData(opcode, payload);
      } else {
        this._fragmentOpcode = opcode;
        this._fragments = [payload];
      }
      return;
    }

    if (opcode === 0x0 && this._fragmentOpcode !== null) {
      this._fragments.push(payload);
      if (fin) {
        const combined = Buffer.concat(this._fragments);
        const op = this._fragmentOpcode;
        this._fragments = [];
        this._fragmentOpcode = null;
        this._emitData(op, combined);
      }
    }
  }

  _emitData(opcode, payload) {
    if (opcode === 0x1) {
      this.emit("message", payload.toString("utf8"));
    } else {
      this.emit("binary", payload);
    }
  }
}

export function isExtensionOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  return (
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://")
  );
}

/**
 * Attach WebSocket upgrade handling onto an existing Node http.Server.
 * By default, only chrome-extension:// and moz-extension:// origins are accepted
 * to prevent Cross-Site WebSocket Hijacking from arbitrary web pages.
 */
export function attachWebSocketServer(httpServer, options = {}) {
  const {
    path: wsPath = "/ws",
    allowOrigin = isExtensionOrigin,
    onConnection,
  } = options;

  httpServer.on("upgrade", (req, socket) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== wsPath) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const origin = req.headers.origin || "";
    if (!allowOrigin(origin, req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");

    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n");

    socket.write(responseHeaders);
    const conn = new WebSocketConnection(socket, req);
    if (onConnection) {
      onConnection(conn, req);
    }
  });
}
