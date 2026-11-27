import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemonServer } from "../src/daemon.mjs";
import { sendCommand } from "../src/client.mjs";
import { parseArgs, runCli } from "../src/cli.mjs";

test("parseArgs parses session, tab, flags, and positional arguments", () => {
  const parsed = parseArgs([
    "-s",
    "codex-1",
    "snapshot",
    "--interactive",
    "--viewport-only",
    "--limit",
    "50",
    "--json",
  ]);
  assert.equal(parsed.command, "snapshot");
  assert.equal(parsed.opts.session, "codex-1");
  assert.equal(parsed.opts.json, true);
  assert.equal(parsed.opts.flags.interactiveOnly, true);
  assert.equal(parsed.opts.flags.viewportOnly, true);
  assert.equal(parsed.opts.flags.limit, 50);

  const shotParsed = parseArgs(["screenshot", "/tmp/a.png", "--annotate"]);
  assert.equal(shotParsed.command, "screenshot");
  assert.equal(shotParsed.opts.flags.annotate, true);
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
            viewport: {
              width: 1440,
              height: 900,
              scrollX: 0,
              scrollY: 120,
              pixelsAbove: 120,
              pixelsBelow: 800,
            },
            count: 2,
            items: [
              { ref: "@1", role: "link", name: "More information" },
              {
                ref: "@2",
                role: "textbox",
                name: "Search",
                value: "",
                states: ["focused"],
              },
            ],
          },
        })
      );
      return;
    }

    if (msg.action === "hover") {
      ext.send(
        JSON.stringify({
          type: "response",
          id: msg.id,
          ok: true,
          result: {
            tabId: 101,
            hovered: { x: 120, y: 240 },
          },
        })
      );
      return;
    }

    if (msg.action === "select") {
      ext.send(
        JSON.stringify({
          type: "response",
          id: msg.id,
          ok: true,
          result: {
            tabId: 101,
            selected: { value: msg.params.value, label: msg.params.value },
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

    if (msg.action === "upload") {
      ext.send(
        JSON.stringify({
          type: "response",
          id: msg.id,
          ok: true,
          result: {
            tabId: 101,
            mode: msg.params.trigger ? "intercept" : "direct",
            files: msg.params.files,
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

  // 4. Run CLI snapshot with viewport-only and verify viewport header + states
  out.length = 0;
  const code2 = await runCli(
    [
      "--port",
      String(port),
      "-s",
      "orca-worker",
      "snapshot",
      "--interactive",
      "--viewport-only",
    ],
    io
  );
  assert.equal(code2, 0);
  assert.match(out[0], /viewport 1440x900 \| 120px above \| 800px below/);
  assert.match(out[0], /@1\s+\[link\] "More information"/);
  assert.match(out[0], /@2\s+\[textbox\] "Search" value="" \[focused\]/);
  const snapAction = seenActions.find((a) => a.action === "snapshot");
  assert.equal(snapAction.params.viewportOnly, true);

  // 5. Run CLI screenshot with --annotate and verify file written
  const shotPath = path.join(os.tmpdir(), `fantuan-test-${Date.now()}.png`);
  out.length = 0;
  const code3 = await runCli(
    ["--port", String(port), "-s", "orca-worker", "screenshot", shotPath, "--annotate"],
    io
  );
  assert.equal(code3, 0);
  assert.equal(out[0], shotPath);
  assert.equal(fs.readFileSync(shotPath, "utf8"), "fake-png-bytes");
  const shotAction = seenActions.find((a) => a.action === "screenshot");
  assert.equal(shotAction.params.annotate, true);

  // 6. Run CLI hover and select
  out.length = 0;
  const codeHover = await runCli(
    ["--port", String(port), "-s", "orca-worker", "hover", "@1"],
    io
  );
  assert.equal(codeHover, 0);
  const hoverAction = seenActions.find((a) => a.action === "hover");
  assert.equal(hoverAction.params.ref, "@1");

  out.length = 0;
  const codeSelect = await runCli(
    ["--port", String(port), "-s", "orca-worker", "select", "@2", "Option A"],
    io
  );
  assert.equal(codeSelect, 0);
  const selectAction = seenActions.find((a) => a.action === "select");
  assert.equal(selectAction.params.ref, "@2");
  assert.equal(selectAction.params.value, "Option A");

  // 7. Run CLI upload (direct & intercept trigger)
  out.length = 0;
  const code4 = await runCli(
    ["--port", String(port), "-s", "orca-worker", "upload", "--trigger", "@1", shotPath],
    io
  );
  assert.equal(code4, 0);
  const uploadAction = seenActions.find((a) => a.action === "upload");
  assert.equal(uploadAction.params.trigger, "@1");
  assert.deepEqual(uploadAction.params.files, [shotPath]);

  fs.unlinkSync(shotPath);

  ext.close();
  await daemon.close();
});

test("daemon automatically shuts down after idleTimeoutMs", async () => {
  let idleFired = false;
  const daemon = createDaemonServer({
    port: 0,
    allowOrigin: () => true,
    idleTimeoutMs: 120,
    onIdleShutdown: () => {
      idleFired = true;
    },
  });
  const { port } = await daemon.start();

  const h1 = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(h1.ok, true);
  assert.equal(h1.idleTimeoutMs, 120);

  await new Promise((r) => setTimeout(r, 250));
  assert.equal(idleFired, true);

  let reachable = true;
  try {
    await fetch(`http://127.0.0.1:${port}/health`);
  } catch {
    reachable = false;
  }
  assert.equal(reachable, false);
});

test("sendCommand waits for late-connecting extension on cold start", async () => {
  const daemon = createDaemonServer({
    port: 0,
    allowOrigin: () => true,
  });
  const { port } = await daemon.start();

  // Connect mock extension 200ms after sendCommand starts
  let ext;
  setTimeout(() => {
    ext = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ext.addEventListener("open", () => {
      ext.send(JSON.stringify({ type: "hello", version: "0.1.0-test" }));
    });
    ext.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "request") {
        ext.send(
          JSON.stringify({
            type: "response",
            id: msg.id,
            ok: true,
            result: { sessions: [] },
          })
        );
      }
    });
  }, 200);

  const res = await sendCommand("sessions", {}, { port, extensionWaitMs: 2000 });
  assert.deepEqual(res, { sessions: [] });

  ext?.close();
  await daemon.close();
});
