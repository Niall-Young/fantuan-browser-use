import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultSession, getPort } from "./config.mjs";
import { getHealth, sendCommand, startDaemon, stopDaemon } from "./client.mjs";

const HELP_TEXT = `fantuan-browser — Silent, Tab-Group-isolated browser automation for AI agents

Usage:
  fantuan-browser [global options] <command> [args]

Global options:
  -s, --session <name>   Tab Group session name (default: $FANTUAN_BROWSER_SESSION or "default")
  -t, --tab <id>         Target specific tab ID inside the session
  --port <port>          Daemon port (default: $FANTUAN_BROWSER_PORT or 19222)
  --json                 Output raw JSON
  -h, --help             Show help

Commands:
  status                              Check daemon & Chrome extension status
  daemon <start|stop|restart|status>  Manage the local bridge daemon
  sessions                            List all active Fantuan Tab Groups
  open <url>                          Open a new background tab in this session's Tab Group
  goto <url>                          Navigate current session tab (or open if none)
  tabs                                List tabs in this session's Tab Group
  use <tabId>                         Set working tab for this session (background)
  focus [tabId]                       Bring tab to foreground (opt-in only)
  close [tabId]                       Close one tab in this session
  cleanup [--all]                     Close all tabs in this session (or all Fantuan sessions)
  info                                Current tab URL, title, viewport, scroll position
  snapshot [--interactive] [--limit N] Print Accessibility Tree with @ref handles
  click <@ref | x y | --selector css> [--double] [--right]
  type [<@ref | --selector css>] <text> [--clear]
  fill <@ref | --selector css> <text> Focus, clear, and insert text
  press <key>                         Press key or combo (e.g. Enter, Escape, Meta+a)
  scroll <dy> [dx]                    Scroll current tab (positive dy scrolls down)
  text [--selector css] [--max N]     Extract visible page text
  eval <js>                           Evaluate JavaScript in the page
  screenshot [path] [--full-page]     Save silent background tab screenshot (PNG)
  upload [@ref] <file...> [--selector css | --trigger @ref|css]
                                      Silently upload local files (no Finder dialog)
  wait <ms | --selector css | --text str> [--timeout ms]
  back | forward | reload             History navigation
  cdp <Domain.method> [jsonParams]    Raw CDP command on current session tab
`;

export function parseArgs(argv) {
  const opts = {
    session: getDefaultSession(),
    tabId: null,
    port: getPort(),
    json: false,
    help: false,
    flags: {},
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "-s" || arg === "--session") {
      opts.session = argv[++i];
    } else if (arg === "-t" || arg === "--tab") {
      opts.tabId = Number(argv[++i]);
    } else if (arg === "--port") {
      opts.port = Number(argv[++i]);
    } else if (arg === "--selector") {
      opts.flags.selector = argv[++i];
    } else if (arg === "--ref") {
      opts.flags.ref = argv[++i];
    } else if (arg === "--trigger") {
      opts.flags.trigger = argv[++i];
    } else if (arg === "--text") {
      opts.flags.text = argv[++i];
    } else if (arg === "--limit") {
      opts.flags.limit = Number(argv[++i]);
    } else if (arg === "--max") {
      opts.flags.maxChars = Number(argv[++i]);
    } else if (arg === "--timeout") {
      opts.flags.timeoutMs = Number(argv[++i]);
    } else if (arg === "--interactive" || arg === "-i") {
      opts.flags.interactiveOnly = true;
    } else if (arg === "--full-page") {
      opts.flags.fullPage = true;
    } else if (arg === "--clear") {
      opts.flags.clear = true;
    } else if (arg === "--all") {
      opts.flags.all = true;
    } else if (arg === "--double") {
      opts.flags.clickCount = 2;
    } else if (arg === "--right") {
      opts.flags.button = "right";
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] || null,
    args: positional.slice(1),
    opts,
  };
}

function formatOutput(command, result, opts) {
  if (opts.json) {
    return JSON.stringify(result, null, 2);
  }

  switch (command) {
    case "snapshot": {
      const header = `[tab ${result.tabId}] ${result.title || "(untitled)"} — ${result.url}`;
      const lines = result.items.map((item) => {
        const val = item.value !== undefined ? ` value=${JSON.stringify(item.value)}` : "";
        const name = item.name ? ` ${JSON.stringify(item.name)}` : "";
        return `${item.ref.padEnd(4)} [${item.role}]${name}${val}`;
      });
      return [header, ...lines].join("\n");
    }
    case "tabs": {
      if (!result.tabs.length) {
        return `No open tabs in session "${result.session}".`;
      }
      return result.tabs
        .map(
          (t) =>
            `${t.current ? "*" : " "} ${t.id}  ${t.title || "(untitled)"}  ${t.url}`
        )
        .join("\n");
    }
    case "sessions": {
      if (!result.sessions.length) {
        return "No active Fantuan Tab Groups.";
      }
      return result.sessions
        .map(
          (s) =>
            `${s.title} (${s.color}, ${s.tabCount} tab${s.tabCount === 1 ? "" : "s"})`
        )
        .join("\n");
    }
    case "text":
      return result.text;
    case "eval":
      return typeof result.value === "string"
        ? result.value
        : JSON.stringify(result.value, null, 2);
    case "screenshot":
      return result.path;
    default:
      return JSON.stringify(result, null, 2);
  }
}

export async function runCli(argv, io = { out: console.log, err: console.error }) {
  const { command, args, opts } = parseArgs(argv);

  if (opts.help || !command) {
    io.out(HELP_TEXT);
    return 0;
  }

  const baseParams = {
    session: opts.session,
    ...(opts.tabId != null ? { tabId: opts.tabId } : {}),
  };
  const clientOpts = {
    port: opts.port,
    ...(opts.flags.timeoutMs ? { timeoutMs: opts.flags.timeoutMs } : {}),
  };

  if (command === "daemon") {
    const sub = args[0] || "status";
    if (sub === "start") {
      const health = await startDaemon(opts.port);
      io.out(JSON.stringify(health, null, 2));
      return 0;
    }
    if (sub === "stop") {
      const res = await stopDaemon(opts.port);
      io.out(JSON.stringify(res, null, 2));
      return 0;
    }
    if (sub === "restart") {
      await stopDaemon(opts.port);
      const health = await startDaemon(opts.port);
      io.out(JSON.stringify(health, null, 2));
      return 0;
    }
    const health = await getHealth(opts.port);
    io.out(JSON.stringify(health || { ok: false, running: false }, null, 2));
    return health ? 0 : 1;
  }

  if (command === "status") {
    const health = await startDaemon(opts.port);
    let sessions = [];
    if (health.extensionConnected) {
      const s = await sendCommand("sessions", {}, clientOpts);
      sessions = s.sessions || [];
    }
    const payload = { ...health, sessions };
    io.out(JSON.stringify(payload, null, 2));
    return health.extensionConnected ? 0 : 2;
  }

  let result;
  switch (command) {
    case "sessions":
      result = await sendCommand("sessions", {}, clientOpts);
      break;
    case "open":
    case "new-tab":
      if (!args[0]) throw new Error("Usage: fantuan-browser open <url>");
      result = await sendCommand("open", { ...baseParams, url: args[0] }, clientOpts);
      break;
    case "goto":
      if (!args[0]) throw new Error("Usage: fantuan-browser goto <url>");
      result = await sendCommand("goto", { ...baseParams, url: args[0] }, clientOpts);
      break;
    case "tabs":
      result = await sendCommand("tabs", baseParams, clientOpts);
      break;
    case "use":
      if (!args[0]) throw new Error("Usage: fantuan-browser use <tabId>");
      result = await sendCommand(
        "use",
        { ...baseParams, tabId: Number(args[0]) },
        clientOpts
      );
      break;
    case "focus":
      result = await sendCommand(
        "focus",
        { ...baseParams, ...(args[0] ? { tabId: Number(args[0]) } : {}) },
        clientOpts
      );
      break;
    case "close":
      result = await sendCommand(
        "close",
        { ...baseParams, ...(args[0] ? { tabId: Number(args[0]) } : {}) },
        clientOpts
      );
      break;
    case "cleanup":
      result = await sendCommand(
        "cleanup",
        { ...baseParams, all: Boolean(opts.flags.all) },
        clientOpts
      );
      break;
    case "info":
      result = await sendCommand("info", baseParams, clientOpts);
      break;
    case "snapshot":
      result = await sendCommand(
        "snapshot",
        {
          ...baseParams,
          interactiveOnly: Boolean(opts.flags.interactiveOnly),
          ...(opts.flags.limit ? { limit: opts.flags.limit } : {}),
        },
        clientOpts
      );
      break;
    case "click": {
      const params = {
        ...baseParams,
        ...(opts.flags.button ? { button: opts.flags.button } : {}),
        ...(opts.flags.clickCount ? { clickCount: opts.flags.clickCount } : {}),
      };
      if (opts.flags.selector) {
        params.selector = opts.flags.selector;
      } else if (args[0]?.startsWith("@")) {
        params.ref = args[0];
      } else if (args.length >= 2 && !Number.isNaN(Number(args[0])) && !Number.isNaN(Number(args[1]))) {
        params.x = Number(args[0]);
        params.y = Number(args[1]);
      } else if (args[0]) {
        params.selector = args[0];
      } else {
        throw new Error("Usage: fantuan-browser click <@ref | x y | --selector css>");
      }
      result = await sendCommand("click", params, clientOpts);
      break;
    }
    case "type":
    case "fill": {
      const params = {
        ...baseParams,
        clear: command === "fill" || Boolean(opts.flags.clear),
      };
      if (opts.flags.selector) {
        params.selector = opts.flags.selector;
        params.text = args.join(" ");
      } else if (args[0]?.startsWith("@")) {
        params.ref = args[0];
        params.text = args.slice(1).join(" ");
      } else if (command === "fill" && args.length >= 2) {
        params.selector = args[0];
        params.text = args.slice(1).join(" ");
      } else {
        params.text = args.join(" ");
      }
      result = await sendCommand(command, params, clientOpts);
      break;
    }
    case "press":
      if (!args[0]) throw new Error("Usage: fantuan-browser press <key>");
      result = await sendCommand("press", { ...baseParams, key: args[0] }, clientOpts);
      break;
    case "scroll": {
      const dy = args[0] !== undefined ? Number(args[0]) : 500;
      const dx = args[1] !== undefined ? Number(args[1]) : 0;
      result = await sendCommand("scroll", { ...baseParams, dy, dx }, clientOpts);
      break;
    }
    case "text":
      result = await sendCommand(
        "text",
        {
          ...baseParams,
          ...(opts.flags.selector ? { selector: opts.flags.selector } : {}),
          ...(opts.flags.maxChars ? { maxChars: opts.flags.maxChars } : {}),
        },
        clientOpts
      );
      break;
    case "eval":
      if (!args.length) throw new Error("Usage: fantuan-browser eval <js>");
      result = await sendCommand(
        "eval",
        { ...baseParams, expression: args.join(" ") },
        clientOpts
      );
      break;
    case "screenshot": {
      const raw = await sendCommand(
        "screenshot",
        { ...baseParams, fullPage: Boolean(opts.flags.fullPage) },
        clientOpts
      );
      const outPath = args[0]
        ? path.resolve(args[0])
        : path.join(os.tmpdir(), `fantuan-screenshot-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(raw.dataBase64, "base64"));
      result = {
        tabId: raw.tabId,
        url: raw.url,
        title: raw.title,
        path: outPath,
      };
      break;
    }
    case "wait": {
      const params = {
        ...baseParams,
        ...(opts.flags.selector ? { selector: opts.flags.selector } : {}),
        ...(opts.flags.text ? { text: opts.flags.text } : {}),
        ...(opts.flags.timeoutMs ? { timeoutMs: opts.flags.timeoutMs } : {}),
        ...(args[0] && !Number.isNaN(Number(args[0])) ? { ms: Number(args[0]) } : {}),
      };
      result = await sendCommand("wait", params, clientOpts);
      break;
    }
    case "back":
    case "forward":
    case "reload":
      result = await sendCommand(command, baseParams, clientOpts);
      break;
    case "upload": {
      const params = {
        ...baseParams,
        ...(opts.flags.selector ? { selector: opts.flags.selector } : {}),
        ...(opts.flags.ref ? { ref: opts.flags.ref } : {}),
        ...(opts.flags.trigger ? { trigger: opts.flags.trigger } : {}),
        ...(opts.flags.timeoutMs ? { timeoutMs: opts.flags.timeoutMs } : {}),
      };
      let fileArgs = args;
      if (!params.ref && !params.selector && !params.trigger && args[0]?.startsWith("@")) {
        params.ref = args[0];
        fileArgs = args.slice(1);
      }
      if (fileArgs.length === 0) {
        throw new Error(
          "Usage: fantuan-browser upload [@ref] <file...> [--selector css | --trigger @ref|css]"
        );
      }
      const files = fileArgs.map((f) => {
        const abs = path.resolve(f);
        if (!fs.existsSync(abs)) {
          throw new Error(`File not found: ${abs}`);
        }
        return abs;
      });
      params.files = files;
      result = await sendCommand("upload", params, clientOpts);
      break;
    }
    case "cdp": {
      if (!args[0]) throw new Error("Usage: fantuan-browser cdp <Domain.method> [jsonParams]");
      const cdpParams = args[1] ? JSON.parse(args[1]) : {};
      result = await sendCommand(
        "cdp",
        { ...baseParams, method: args[0], cdpParams },
        clientOpts
      );
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}. Run "fantuan-browser --help".`);
  }

  io.out(formatOutput(command, result, opts));
  return 0;
}
