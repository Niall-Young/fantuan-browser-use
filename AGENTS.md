# fantuan-browser-use

Silent, Tab-Group-isolated Chrome automation for AI agents, composed of a Chrome MV3 extension, a zero-dependency Node.js local WebSocket/HTTP bridge daemon, a CLI, and a reusable Agent Skill.

## Runtime and Tooling

- Node.js >= 20 (`"type": "module"`, zero npm runtime dependencies).
- Run tests: `npm test` (verified).
- Syntax-check extension scripts: `node --check extension/background.js && node --check extension/popup.js` (verified).
- Install CLI and Skill locally: `npm run install-local` (declared in `package.json`).

## Boundaries

- Keep the local bridge bound to `127.0.0.1` and require `chrome-extension://` or `moz-extension://` `Origin` headers on WebSocket upgrades in production to prevent Cross-Site WebSocket Hijacking.
- Keep all agent browser actions strictly scoped to tabs inside the session's `Fantuan` / `Fantuan:<session>` Chrome Tab Group; never mutate unmanaged user tabs or activate/focus tabs unless the `focus` command is explicitly called.
- Preserve zero-dependency ESM compatibility unless a dependency is explicitly justified and approved.
