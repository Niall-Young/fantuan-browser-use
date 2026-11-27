# Privacy Policy — Fantuan Browser Bridge

**Last updated:** 2026-11-27

Fantuan Browser Bridge ("the Extension") is an open-source Chrome extension designed to bridge your local AI agent CLI (`fantuan-browser`) with Chrome tabs inside isolated `Fantuan` Tab Groups.

## 1. Data Collection & Transmission

**The Extension does not collect, store, sell, or transmit any user data to external servers or third parties.**

- All communication happens strictly over your local loopback interface (`ws://127.0.0.1:<port>`, default port `19222`) between the Extension and the local `fantuan-browser` daemon running on your own machine.
- No analytics, telemetry, crash reports, or tracking scripts are included in the Extension.
- No data ever leaves your computer via the Extension.

## 2. Local Storage

The Extension uses `chrome.storage.local` solely to remember one user-configured setting:

- `port`: the local TCP port number (default `19222`) used to connect to your local `fantuan-browser` daemon.

## 3. Permissions & Scope

The Extension requests only the Chrome APIs required for its single purpose:

- **`tabs` & `tabGroups`**: Used to create, group, query, and close background tabs strictly within `Fantuan` / `Fantuan:<session>` Tab Groups. Unmanaged personal tabs outside these groups are never modified.
- **`debugger`**: Used strictly on tabs inside managed `Fantuan` Tab Groups to inspect the Accessibility Tree, dispatch background input/click/upload actions, and capture screenshots via Chrome DevTools Protocol (CDP 1.3) without stealing focus from your active tab.
- **`alarms`**: Used to keep the Manifest V3 service worker alive and automatically reconnect to the local `127.0.0.1` bridge daemon.
- **`storage`**: Used to save the configured local bridge port in `chrome.storage.local`.

## 4. Open Source & Contact

The full source code is publicly auditable at:
https://github.com/Niall-Young/fantuan-browser-use

If you have any questions or privacy concerns, please open an issue at:
https://github.com/Niall-Young/fantuan-browser-use/issues
