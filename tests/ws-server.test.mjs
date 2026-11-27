import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { attachWebSocketServer, isExtensionOrigin } from "../src/ws-server.mjs";

test("isExtensionOrigin allows chrome-extension and rejects web origins", () => {
  assert.equal(isExtensionOrigin("chrome-extension://abcdefghijklmnop"), true);
  assert.equal(isExtensionOrigin("moz-extension://1234-5678"), true);
  assert.equal(isExtensionOrigin("https://evil.example"), false);
  assert.equal(isExtensionOrigin("http://localhost:3000"), false);
  assert.equal(isExtensionOrigin(""), false);
});

test("WebSocket server handles RFC 6455 handshake, small and large (>128KB) payloads", async () => {
  const server = http.createServer();
  const received = [];

  attachWebSocketServer(server, {
    path: "/ws",
    allowOrigin: () => true,
    onConnection(conn) {
      conn.on("message", (text) => {
        received.push(text);
        conn.sendText(`echo:${text.length}`);
      });
    },
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const replies = [];

  await new Promise((resolve, reject) => {
    client.addEventListener("open", resolve, { once: true });
    client.addEventListener("error", reject, { once: true });
  });

  const waitForReply = () =>
    new Promise((resolve) => {
      client.addEventListener("message", (ev) => resolve(ev.data), { once: true });
    });

  // Small message
  const p1 = waitForReply();
  client.send("hello");
  replies.push(await p1);

  // Large message (> 128 KB, tests 64-bit payload length header)
  const big = "A".repeat(150_000);
  const p2 = waitForReply();
  client.send(big);
  replies.push(await p2);

  assert.deepEqual(replies, ["echo:5", "echo:150000"]);
  assert.equal(received[0], "hello");
  assert.equal(received[1].length, 150_000);

  client.close();
  await new Promise((r) => server.close(r));
});

test("WebSocket server rejects disallowed web Origin with 403", async () => {
  const server = http.createServer();
  attachWebSocketServer(server, {
    path: "/ws",
    allowOrigin: isExtensionOrigin,
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const statusCode = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/ws",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
        Origin: "https://evil.example",
      },
    });
    req.on("response", (res) => resolve(res.statusCode));
    req.on("error", reject);
    req.end();
  });

  assert.equal(statusCode, 403);
  await new Promise((r) => server.close(r));
});
