import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemonServer } from "../src/daemon.mjs";
import { parseArgs, runCli } from "../src/cli.mjs";

test("parseArgs parses session, tab, flags, and positional arguments", () => {
  const parsed = parseArgs([
    "-s",
    "codex-1",
    "snapshot",
    "--interactive",
    "--limit",
    "50",
    "--json",
  ]);
  assert.equal(parsed.command, "snapshot");
  assert.equal(parsed.opts.session, "codex-1");
  assert.equal(parsed.opts.json, true);
  assert.equal(parsed.opts.flags.interactiveOnly, true);
  assert.equal(parsed.opts.flags.limit, 50);
});

test("daemon + CLI end-to-end with mock extension", async () => {
  const daemon = createDaemonServer({
    port: 0,
    allowOrigin: () => true,
  });
  const { port } = await daemon.start();

  // 1. Before extension connects, /health reports extensionConnected: false
  const h1 = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(h1.ok, true);
  assert.equal(h1.extensionConnected, false);

  // 2. Connect mock extension
  const ext = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const seenActions = [];

  await new Promise((resolve, reject) => {
    ext.addEventListener("open", () => {
      ext.send(JSON.stringify({ type: "hello", version: "0.1.0-test" }));
      resolve();
    }, { once: true });
    ext.addEventListener("error", reject, { once: true });
  });

  ext.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "request") return;
    seenActions.push({ action: msg.action, params: msg.params });

    if (msg.action === "open") {
      ext.send(
        JSON.stringify({
          type: "response",
          id: msg.id,
          ok: true,
          result: {
            session: msg.params.session,
            groupId: 42,
            tabId: 101,
            url: msg.params.url,
            title: "Example",
          },
        })
      );
      return;
    }

    if (msg.action === "snapshot") {
      ext.send(
        JSON.stringify({
          type: "response",
          id: msg.id,
          ok: true,
          result: {
            tabId: 101,
            url: "https://example.com",
            title: "Example",
            count: 2,
            items: [
              { ref: "@1", role: "link", name: "More information" },
              { ref: "@2", role: "textbox", name: "Search", value: "" },
            ],
          },
        })
      );
      return;
    }

    if (msg.action === "screenshot") {
      ext.send(
        JSON.stringify({
          type: "response",
          id: msg.id,
          ok: true,
          result: {
            tabId: 101,
            url: "https://example.com",
            title: "Example",
            dataBase64: Buffer.from("fake-png-bytes").toString("base64"),
          },
        })
      );
      return;
    }

    ext.send(
      JSON.stringify({
        type: "response",
        id: msg.id,
        ok: false,
        error: `Unhandled mock action: ${msg.action}`,
      })
    );
  });

  // Give hello a moment to process
  await new Promise((r) => setTimeout(r, 50));

  const out = [];
  const io = { out: (s) => out.push(s), err: () => {} };

  // 3. Run CLI open with isolated session
  const code1 = await runCli(
    ["--port", String(port), "-s", "orca-worker", "open", "https://example.com"],
    io
  );
  assert.equal(code1, 0);
  assert.equal(seenActions[0].action, "open");
  assert.equal(seenActions[0].params.session, "orca-worker");

  // 4. Run CLI snapshot
  out.length = 0;
  const code2 = await runCli(
    ["--port", String(port), "-s", "orca-worker", "snapshot", "--interactive"],
    io
  );
  assert.equal(code2, 0);
  assert.match(out[0], /@1\s+\[link\] "More information"/);
  assert.match(out[0], /@2\s+\[textbox\] "Search"/);

  // 5. Run CLI screenshot and verify file written
  const shotPath = path.join(os.tmpdir(), `fantuan-test-${Date.now()}.png`);
  out.length = 0;
  const code3 = await runCli(
    ["--port", String(port), "-s", "orca-worker", "screenshot", shotPath],
    io
  );
  assert.equal(code3, 0);
  assert.equal(out[0], shotPath);
  assert.equal(fs.readFileSync(shotPath, "utf8"), "fake-png-bytes");
  fs.unlinkSync(shotPath);

  ext.close();
  await daemon.close();
});
