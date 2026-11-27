# fantuan-browser-use

为 Orca 中的 AI Agent（Claude Code、Codex、Antigravity 等）打造的静默、零弹窗、按 Tab Group 隔离的 Chrome 浏览器自动化扩展、CLI 与通用 Skill。

[中文](#中文) | [English](#english)

---

<a id="中文"></a>
## 中文

### 项目简介

`fantuan-browser-use` 解决传统本地 CDP CLI（如 `browser-use` CLI）在日常 Chrome 中使用时的两个核心痛点：

1. **不再弹出“允许远程调试 / 接管控制台”确认框**：通过 Chrome MV3 扩展 + 本地 WebSocket 守护进程通信，天然复用当前 Chrome 登录态，无需开启 `chrome://inspect/#remote-debugging`。
2. **自动按会话创建独立 Tab Group 并后台静默操作**：每个任务/Agent 自动在专属分组（`Fantuan` 或 `Fantuan:<session>`）内以 `active: false` 打开并操作标签页，不切换、不干扰用户当前正在浏览的页面。

### 核心能力

- **零弹窗复用登录态**：直接运行在你的日常 Chrome 中，共享 Cookie 与登录会话。
- **Tab Group 多 Agent 隔离**：通过 `-s / --session <name>` 或 `FANTUAN_BROWSER_SESSION` 为每个任务创建独立颜色分组，支持一键 `cleanup` 清理，且严格禁止触碰分组外的用户个人标签页。
- **后台静默操控与截图**：基于 Tab 级 `chrome.debugger`（CDP 1.3），支持视口感知与状态标注的无障碍树快照（`snapshot --interactive --viewport-only` 输出 `@1`, `@2` 短句柄与滚动进度）、点击、悬停（`hover`）、下拉选择（`select`）、输入、按键、滚动、静默文件上传（`upload`，绕过系统 Finder 弹窗）、JS 弹窗自动防卡死、新开 `target="_blank"` 标签页自动收入当前分组、JS 执行、原始 CDP 调用以及带 `@ref` 编号标注的静默截图（`screenshot --annotate`）。
- **零外部依赖**：纯 Node.js ESM 实现 RFC 6455 WebSocket 服务端与 HTTP 桥接守护进程，严格校验 `chrome-extension://` Origin 防止跨站劫持。
- **开箱即用的通用 Skill**：提供 `skill/fantuan-browser/SKILL.md` 及一键安装脚本，适配 Orca 下的多个 AI Agent。

### 快速开始

#### 环境要求

- Node.js >= 20
- Google Chrome（或支持 MV3 与 `chrome.tabGroups` 的 Chromium 浏览器）

#### 安装

1. 运行本地安装脚本（将 `fantuan-browser` 软链到 `~/.local/bin`，并将 Skill 软链到 `~/.agents/skills` 及已存在的 `~/.gemini/antigravity-cli/skills`）：

```sh
npm run install-local
```

2. 在 Chrome 中加载未打包扩展（一次性操作）：
   - 打开 `chrome://extensions`
   - 开启右上角 **开发者模式（Developer mode）**
   - 点击 **加载已解压的扩展程序（Load unpacked）**，选择本仓库的 `extension/` 目录

#### 运行与检查

```sh
fantuan-browser status
```

看到 `"extensionConnected": true` 即表示桥接就绪（CLI 会自动拉起本地守护进程）。

### 使用方法

```sh
# 1. 为当前任务开启独立 Tab Group（Fantuan:demo）并在后台打开页面
fantuan-browser -s demo open https://example.com

# 2. 获取交互元素的无障碍树快照（返回 @1, @2... 句柄与视口滚动进度）
fantuan-browser -s demo snapshot --interactive --viewport-only

# 3. 后台静默点击、悬停、选择、输入、按键、等待、上传文件与标注截图
fantuan-browser -s demo click @1
fantuan-browser -s demo hover @2
fantuan-browser -s demo select @3 "选项 A"
fantuan-browser -s demo fill @4 "搜索内容"
fantuan-browser -s demo press Enter
fantuan-browser -s demo wait --text "结果"
fantuan-browser -s demo upload /path/to/file.png
fantuan-browser -s demo upload --trigger @5 /path/to/image.png
fantuan-browser -s demo screenshot /tmp/demo.png --annotate

# 4. 任务完成后一键关闭该会话的所有标签页与分组
fantuan-browser -s demo cleanup

# 5. 检查或升级 CLI 到最新 GitHub Release
fantuan-browser update --check
fantuan-browser update
```

### 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FANTUAN_BROWSER_PORT` | `19222` | 本地守护进程监听端口（也可在扩展弹窗中修改） |
| `FANTUAN_BROWSER_SESSION` | `default` | 默认会话名（对应 `Fantuan` 或 `Fantuan:<session>` 分组） |
| `FANTUAN_BROWSER_STATE_DIR` | `~/.fantuan-browser` | 守护进程 PID 与日志目录 |
| `FANTUAN_BROWSER_IDLE_MS` | `600000` | 守护进程空闲自动退出时间（毫秒，默认 10 分钟；设为 `0` 可禁用自动退出） |
| `FANTUAN_BROWSER_REPO` | `Niall-Young/fantuan-browser-use` | `fantuan-browser update` 检查 GitHub Release 的仓库名 |

### 项目结构

- `extension/`：Chrome MV3 扩展（`manifest.json`、`background.js`、`popup.html`、`popup.js`、`icons/`）
- `src/`：零依赖本地守护进程、RFC 6455 WebSocket 服务端与 CLI 实现
- `bin/fantuan-browser`：CLI 可执行入口
- `skill/fantuan-browser/SKILL.md`：面向 AI Agent 的通用 Skill
- `scripts/install.mjs`：CLI 与 Skill 一键软链安装脚本
- `scripts/pack-extension.mjs`：Chrome Web Store 扩展 ZIP 打包脚本（输出到 `dist/`）
- `docs/chrome-web-store/listing.md`：Chrome Web Store 上架文案、权限理由与审核说明
- `PRIVACY.md`：扩展隐私政策文档
- `tests/`：基于 `node:test` 的单元测试与端到端测试

### 开发与验证

```sh
npm test
node --check extension/background.js && node --check extension/popup.js
npm run pack:extension
```

### 常见问题

- **`extensionConnected: false`**：确认 Chrome 已打开、扩展已启用且未报错；点击扩展图标可查看连接状态或手动点击 **Reconnect**。
- **浏览器顶部出现“Fantuan Browser Bridge 已开始调试此浏览器”横条**：这是 Chrome 对 `chrome.debugger` 扩展 API 的标准非阻塞提示（与 Claude in Chrome 一致），不会弹窗阻塞，也不会切走你的当前标签页。

### 许可证

MIT

[English](#english) · [返回顶部](#fantuan-browser-use)

---

<a id="english"></a>
## English

### Overview

`fantuan-browser-use` solves two core pain points of traditional local CDP CLIs (such as `browser-use` CLI) when driving your daily Chrome browser:

1. **No "Allow remote debugging?" modal dialogs**: Uses a Chrome MV3 extension + local WebSocket bridge daemon instead of `chrome://inspect/#remote-debugging`, automatically reusing your existing Chrome logins and cookies.
2. **Automatic per-session Tab Groups with silent background execution**: Every task or agent opens and operates background tabs (`active: false`) inside its own Chrome Tab Group (`Fantuan` or `Fantuan:<session>`) without switching or disturbing your active tab.

### Features

- **Zero modal dialogs & shared logins**: Runs inside your regular Chrome profile, preserving cookies and authenticated sessions.
- **Per-session Tab Group isolation**: Pass `-s / --session <name>` (or `FANTUAN_BROWSER_SESSION`) to give each concurrent agent its own color-coded Tab Group with one-command `cleanup`, while strictly refusing to touch unmanaged personal tabs.
- **Silent background control & screenshots**: Uses tab-scoped `chrome.debugger` (CDP 1.3) for viewport-aware Accessibility Tree snapshots (`snapshot --interactive --viewport-only` with short `@1`, `@2` refs, element states, and scroll progress), clicks, `hover`, `select`, text insertion, key combos, scrolling, silent file uploads (`upload`, bypassing OS Finder dialogs), auto-handled JS dialogs, automatic capture of `target="_blank"` child tabs into the session Tab Group, JS evaluation, raw CDP passthrough, and Set-of-Mark annotated screenshots (`screenshot --annotate`).
- **Zero runtime dependencies**: Pure Node.js ESM RFC 6455 WebSocket server and HTTP bridge daemon with strict `chrome-extension://` Origin validation against Cross-Site WebSocket Hijacking.
- **Universal Agent Skill**: Ships `skill/fantuan-browser/SKILL.md` and a one-command local installer for agents running in Orca (Claude Code, Codex, Antigravity, etc.).

### Quick Start

#### Prerequisites

- Node.js >= 20
- Google Chrome (or a Chromium browser supporting MV3 and `chrome.tabGroups`)

#### Install

1. Run the local installer (symlinks `fantuan-browser` into `~/.local/bin` and symlinks the Skill into `~/.agents/skills` and, if present, `~/.gemini/antigravity-cli/skills`):

```sh
npm run install-local
```

2. Load the unpacked extension in Chrome (one-time setup):
   - Open `chrome://extensions`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked** and select this repository's `extension/` directory

#### Run and Check

```sh
fantuan-browser status
```

Once `"extensionConnected": true` appears, the bridge is ready (the CLI starts the local daemon automatically).

### Usage

```sh
# 1. Open a background tab in an isolated Tab Group (Fantuan:demo)
fantuan-browser -s demo open https://example.com

# 2. Inspect interactive elements via Accessibility Tree (@1, @2... refs & scroll progress)
fantuan-browser -s demo snapshot --interactive --viewport-only

# 3. Interact, upload files, and capture annotated screenshots silently in the background
fantuan-browser -s demo click @1
fantuan-browser -s demo hover @2
fantuan-browser -s demo select @3 "Option A"
fantuan-browser -s demo fill @4 "search query"
fantuan-browser -s demo press Enter
fantuan-browser -s demo wait --text "Results"
fantuan-browser -s demo upload /path/to/file.png
fantuan-browser -s demo upload --trigger @5 /path/to/image.png
fantuan-browser -s demo screenshot /tmp/demo.png --annotate

# 4. Close all tabs in this session's Tab Group when finished
fantuan-browser -s demo cleanup

# 5. Check for or install the latest GitHub Release for the CLI
fantuan-browser update --check
fantuan-browser update
```

### Configuration

| Environment Variable | Default | Description |
| --- | --- | --- |
| `FANTUAN_BROWSER_PORT` | `19222` | Local daemon port (also configurable in the extension popup) |
| `FANTUAN_BROWSER_SESSION` | `default` | Default session name (`Fantuan` or `Fantuan:<session>` Tab Group) |
| `FANTUAN_BROWSER_STATE_DIR` | `~/.fantuan-browser` | Directory for daemon PID and log files |
| `FANTUAN_BROWSER_IDLE_MS` | `600000` | Idle auto-shutdown timeout in ms (default 10 minutes; set `0` to disable) |
| `FANTUAN_BROWSER_REPO` | `Niall-Young/fantuan-browser-use` | GitHub repository checked by `fantuan-browser update` |

### Project Structure

- `extension/`: Chrome MV3 extension (`manifest.json`, `background.js`, `popup.html`, `popup.js`, `icons/`)
- `src/`: Zero-dependency local daemon, RFC 6455 WebSocket server, and CLI implementation
- `bin/fantuan-browser`: Executable CLI entrypoint
- `skill/fantuan-browser/SKILL.md`: Universal Skill for AI agents
- `scripts/install.mjs`: Local symlink installer for CLI and Skill
- `scripts/pack-extension.mjs`: Chrome Web Store extension ZIP packager (outputs to `dist/`)
- `docs/chrome-web-store/listing.md`: Chrome Web Store listing copy, permission justifications, and reviewer notes
- `PRIVACY.md`: Extension privacy policy
- `tests/`: `node:test` unit and end-to-end tests

### Development and Verification

```sh
npm test
node --check extension/background.js && node --check extension/popup.js
npm run pack:extension
```

### Troubleshooting

- **`extensionConnected: false`**: Make sure Chrome is running and the unpacked extension is enabled; click the extension icon to inspect status or click **Reconnect**.
- **Top browser banner ("Fantuan Browser Bridge started debugging this browser")**: This is Chrome's standard non-blocking infobar for `chrome.debugger` extensions (same as Claude in Chrome). It never opens a modal dialog and never switches your active tab.

### License

MIT

[中文](#中文) · [Back to top](#fantuan-browser-use)
