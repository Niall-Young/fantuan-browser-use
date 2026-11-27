---
name: fantuan-browser
description: "Silent, Tab-Group-isolated browser automation in the user's real Chrome (no remote-debugging modal dialogs, no focus stealing). Use when an AI agent needs to browse, interact with logged-in web apps, read dynamic pages, click/fill forms, or capture screenshots without interrupting the user."
---

# Fantuan Browser

Control the user's real Chrome silently through the **Fantuan Browser Bridge** extension and `fantuan-browser` CLI.

- **Zero modal dialogs**: Uses a Chrome MV3 extension + local WebSocket daemon (no `chrome://inspect/#remote-debugging` permission popups).
- **Silent Tab Group isolation**: Automatically opens background tabs (`active: false`) inside a dedicated Chrome Tab Group (`Fantuan` or `Fantuan:<session>`) and never touches or switches the user's personal tabs.
- **Logged-in sessions**: Runs in the user's normal Chrome profile, reusing existing cookies/logins.

## When Not to Use

For public static pages or REST APIs that don't require login, JS rendering, or interaction, prefer `curl` or HTTP fetch tools.

## Session Isolation (Important for Multi-Agent / Orca)

Always pass a short `--session <name>` (or set `FANTUAN_BROWSER_SESSION=<name>`) when working in parallel with other agents or on a distinct task:

```bash
fantuan-browser -s x-draft open https://x.com
```

Each session gets its own color-coded Tab Group (`Fantuan:x-draft`) and can be cleaned up independently without affecting other agents or the user.

## Core Workflow

1. **Check connection** (auto-starts the local daemon):
   ```bash
   fantuan-browser status
   ```
   If `extensionConnected` is `false`, ask the user to confirm Chrome is open and the unpacked extension (`extension/`) is enabled in `chrome://extensions`.

2. **Open a background tab** in your session's Tab Group:
   ```bash
   fantuan-browser -s mytask open https://example.com
   ```
   Use `goto <url>` to reuse the current session tab instead of creating duplicate tabs.

3. **Inspect elements via Accessibility Tree (`snapshot`)** — prefer this over screenshots:
   ```bash
   fantuan-browser -s mytask snapshot --interactive
   ```
   Output gives short `@ref` handles (`@1`, `@2`, ...) for buttons, links, and inputs.

4. **Interact silently in the background**:
   ```bash
   fantuan-browser -s mytask click @5
   fantuan-browser -s mytask fill @8 "search query"
   fantuan-browser -s mytask press Enter
   fantuan-browser -s mytask wait --text "Results"
   fantuan-browser -s mytask scroll 600
   ```

5. **Extract content or capture silent background screenshots**:
   ```bash
   fantuan-browser -s mytask text --max 8000
   fantuan-browser -s mytask eval "document.title"
   fantuan-browser -s mytask screenshot /tmp/page.png
   ```

6. **Clean up when finished** (closes all tabs in your session's Tab Group):
   ```bash
   fantuan-browser -s mytask cleanup
   ```

## Rules

- **Never call `focus`** unless the user explicitly asks to see the tab or solve a login/CAPTCHA manually.
- **Keep tabs tidy**: Reuse the session tab with `goto` and run `cleanup` when a temporary task finishes.
- **Login walls / CAPTCHAs / payments**: Stop and ask the user rather than guessing credentials or bypassing anti-bot checks.
- **Raw CDP**: For advanced operations (cookies, network, iframes), use `fantuan-browser -s <name> cdp <Domain.method> '<json>'`.
