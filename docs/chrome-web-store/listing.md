# Chrome Web Store 上架文案与审核材料（Fantuan Browser Bridge）

本文档整理了在 Chrome Web Store Developer Dashboard 提交 **Fantuan Browser Bridge** 所需的全部中英文文案、权限理由、隐私声明、审核测试步骤与素材规格，可直接复制粘贴使用。

---

## 1. Store Listing（商店商品详情）

### 基础字段

| 字段 | 建议填写内容 |
| --- | --- |
| **Extension Name（名称）** | `Fantuan Browser Bridge`（与 `manifest.json` 一致，22/75 字符） |
| **Category（类别）** | `Developer Tools`（开发者工具） |
| **Primary Language（主要语言）** | `English`（可额外添加 `Chinese (Simplified)` 本地化） |
| **Homepage URL（官网）** | `https://github.com/Niall-Young/fantuan-browser-use` |
| **Support URL（支持网址）** | `https://github.com/Niall-Young/fantuan-browser-use/issues` |
| **Privacy Policy URL（隐私政策网址）** | `https://github.com/Niall-Young/fantuan-browser-use/blob/main/PRIVACY.md`（push 后即生效） |

---

### Summary（简短描述，上限 132 字符）

**English（103 chars — 与 `manifest.json` 保持一致）：**
```text
Silent, Tab-Group-isolated browser automation bridge for AI agents (no remote-debugging modal dialogs).
```

**中文（45 字）：**
```text
面向 AI Agent 的静默浏览器自动化桥接扩展：按 Tab Group 隔离，零远程调试弹窗，不打扰日常浏览。
```

---

### Detailed Description（详细说明）

#### English（推荐作为主语言）

```text
Fantuan Browser Bridge connects your local AI agents (such as Claude Code, Codex, Antigravity, or custom scripts using the open-source `fantuan-browser` CLI) to your real Chrome browser—silently, safely, and without interrupting your workflow.

WHY FANTUAN BROWSER BRIDGE?
Traditional local CDP tools require enabling remote debugging, trigger annoying "Allow remote debugging?" modal dialogs, or steal focus by switching tabs while you work. Fantuan Browser Bridge solves both problems:

• Zero Modal Dialogs & Shared Logins
  Runs directly inside your regular Chrome profile via a local WebSocket bridge (127.0.0.1), naturally reusing your existing logins and cookies without remote-debugging permission popups.

• Automatic Tab-Group Isolation
  Every agent session automatically gets its own color-coded Chrome Tab Group ("Fantuan" or "Fantuan:<session>"). The extension strictly operates only on tabs inside managed Fantuan Tab Groups and never touches your personal tabs.

• Silent Background Execution
  Opens pages with active: false, reads Accessibility Tree snapshots, clicks, hovers, fills forms, uploads files silently, handles JS dialogs, and captures annotated screenshots in the background—without switching away from your active tab.

• Popup Control Panel
  Click the extension icon anytime to check local bridge connection status, customize the local port (default 19222), view active agent Tab Groups, reconnect, or close all agent tabs in one click.

• 100% Local & Open Source
  All traffic stays strictly on 127.0.0.1. Zero telemetry, zero analytics, zero cloud servers.

GETTING STARTED
1. Install this Chrome extension.
2. Install the companion open-source CLI (`fantuan-browser`) from GitHub:
   https://github.com/Niall-Young/fantuan-browser-use
3. Run `fantuan-browser status` — the extension icon badge will turn green ("ON") once connected.

Note: When automating a managed tab, Chrome displays its standard non-blocking infobar ("Fantuan Browser Bridge started debugging this browser"). It will not interrupt or switch your active tab.
```

#### 中文（用于添加 Simplified Chinese 本地化）

```text
Fantuan Browser Bridge 将你本机的 AI Agent（如 Claude Code、Codex、Antigravity 或通过开源 `fantuan-browser` CLI 编写的自动化脚本）与日常使用的 Chrome 浏览器桥接起来，实现静默、安全、不打扰日常浏览的网页自动化。

核心特性：

• 零弹窗复用登录态
  通过本地 WebSocket（127.0.0.1）与本机守护进程通信，直接复用当前 Chrome 的登录态与 Cookie，无需开启 remote-debugging，告别反复弹出的远程调试确认框。

• 按 Tab Group 自动隔离
  每个 AI Agent 会话自动拥有独立颜色的 Chrome 标签页分组（Fantuan 或 Fantuan:<session>）。扩展严格仅操作分组内的受管标签页，绝不触碰你的个人标签页。

• 后台静默执行，不抢焦点
  支持后台打开页面（active: false）、无障碍树快照、静默点击/悬停/输入/下拉选择/按键/滚动、静默文件上传、JS 弹窗防卡死以及带标注的静默截图，全程不切走你正在浏览的标签页。

• 一键状态面板
  点击工具栏图标即可查看本地连接状态、修改本地监听端口（默认 19222）、查看当前活跃的 Agent 分组，并支持一键重连或一键清理全部 Agent 标签页。

• 100% 本地运行，开源透明
  所有通信仅限本机 127.0.0.1，无任何远程服务器、无埋点、无数据上传。

快速开始：
1. 安装本 Chrome 扩展。
2. 从 GitHub 安装配套的开源本地 CLI（fantuan-browser）：
   https://github.com/Niall-Young/fantuan-browser-use
3. 运行 `fantuan-browser status`，看到扩展图标显示绿色 “ON” 即表示桥接就绪。
```

---

## 2. Privacy Practices（隐私权做法 — 审核重点）

> [!IMPORTANT]
> Chrome Web Store 对含 `debugger` 和 `tabs` 权限的扩展审核非常严格。以下英文理由已按 Chrome Web Store 审核标准编写，建议直接粘贴英文版。

### Single Purpose Description（单一用途说明）

```text
Bridge a user-installed local AI agent CLI (fantuan-browser) over 127.0.0.1 to silently automate web pages strictly inside isolated "Fantuan" Chrome Tab Groups without disturbing the user's personal tabs.
```

### Permission Justifications（逐项权限理由）

#### `tabs`
```text
Required to create background tabs (active: false), query tabs belonging to managed "Fantuan" / "Fantuan:<session>" Tab Groups, capture child tabs opened via target="_blank" into the same group, and close managed tabs when the user runs cleanup. Unmanaged personal tabs are never modified.
```

#### `tabGroups`
```text
Required to create, title, color-code, query, and manage isolated "Fantuan" and "Fantuan:<session>" Tab Groups so automated agent tabs remain clearly separated from the user's personal browsing tabs and can be closed in one click from the popup or CLI.
```

#### `debugger`
```text
Required to attach Chrome DevTools Protocol (CDP 1.3) strictly to tabs inside managed "Fantuan" Tab Groups. This enables background Accessibility Tree inspection, reliable mouse/keyboard/form input, file input binding, JS dialog handling, and background screenshots without activating or stealing focus from the user's current tab. The debugger is never attached to unmanaged personal tabs.
```

#### `alarms`
```text
Required to periodically wake the Manifest V3 service worker and maintain or reconnect the local WebSocket connection (ws://127.0.0.1:<port>) to the user's local fantuan-browser daemon.
```

#### `storage`
```text
Required solely to store the user's configured local bridge port number (default 19222) in chrome.storage.local so it persists across browser restarts.
```

### Host Permissions Justification（如有提示）
- 本扩展**未声明** `host_permissions` 或 `<all_urls>`，如页面未出现该输入框则无需填写。

### Are you using remote code?（是否使用远程代码）
- 选择：**`No, I am not using Remote code`**
- 说明：所有 JavaScript 逻辑均完整打包在扩展包内（`background.js`、`popup.js`），不动态加载任何外部脚本。

### Data Usage（数据使用声明）
- **What user data do you plan to collect from users now or in the future?**
  - **全部不勾选**（扩展本身不向任何远程服务器收集、上传或存储用户数据；所有指令与页面交互均完全留在用户本机 `127.0.0.1`）。
- **Certify the following disclosures（底部 3 个合规声明）**：
  - `[x]` I do not sell or transfer user data to third parties, outside of the approved use cases
  - `[x]` I do not use or transfer user data for purposes that are unrelated to the item's single purpose
  - `[x]` I do not use or transfer user data to determine creditworthiness or for lending purposes

---

## 3. Distribution -> Notes for Reviewer（给审核人员的测试说明）

> [!TIP]
> 强烈建议在提审页面的 "Notes for reviewer"（审核备注）中填写以下说明，避免审核员因为本机未启动配套 CLI 而误判“扩展无响应/无法测试”。

```text
Fantuan Browser Bridge is a local companion extension for the open-source CLI `fantuan-browser` (https://github.com/Niall-Young/fantuan-browser-use).

How to test:
1. Install the extension and click its toolbar icon. The popup shows the connection badge ("Disconnected" until the local daemon starts), a configurable local port (default 19222), active Tab Groups, "Reconnect", and "Cleanup All".
2. Clone the open-source companion repo (Node.js >= 20, zero npm dependencies):
   git clone https://github.com/Niall-Young/fantuan-browser-use.git
   cd fantuan-browser-use
3. Run:
   ./bin/fantuan-browser status
   (The CLI automatically starts the local daemon on 127.0.0.1:19222. Within 1–2 seconds the extension connects and its badge turns green "ON".)
4. Test isolated Tab Group automation:
   ./bin/fantuan-browser -s review open https://example.com
   ./bin/fantuan-browser -s review snapshot --interactive
   ./bin/fantuan-browser -s review cleanup

Security notes:
- The extension only connects to ws://127.0.0.1:<port> (localhost).
- No data is sent to any external server.
- All tabs/debugger operations are strictly scoped to tabs inside "Fantuan" / "Fantuan:<session>" Tab Groups.
```

---

## 4. 商店视觉素材清单（Graphic Assets）

| 素材项 | 要求规格 | 当前状态 |
| --- | --- | --- |
| **Store Icon（商店图标）** | `128 x 128` PNG | 已就绪：`extension/icons/icon128.png` |
| **Screenshots（功能截图）** | `1280 x 800` 或 `640 x 400`（1~5 张，JPEG 或 24-bit PNG 无透明通道） | 建议截取 2~3 张：1) Chrome 中 `Fantuan` 彩色 Tab Group + 扩展弹窗面板；2) 终端运行 `fantuan-browser` 与后台静默操作对比图 |
| **Small Promo Tile（小宣传图，可选）** | `440 x 280` JPEG / 24-bit PNG | 可选 |
| **Marquee Promo Tile（大宣传图，可选）** | `1400 x 560` JPEG / 24-bit PNG | 可选 |
