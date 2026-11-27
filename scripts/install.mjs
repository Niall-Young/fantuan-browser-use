#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BIN_SRC = path.join(REPO_ROOT, "bin", "fantuan-browser");
const SKILL_SRC = path.join(REPO_ROOT, "skill", "fantuan-browser");
const EXT_DIR = path.join(REPO_ROOT, "extension");

function ensureSymlink(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {
    // does not exist
  }
  fs.symlinkSync(target, linkPath);
}

// 1. Ensure CLI is executable and symlinked into ~/.local/bin
fs.chmodSync(BIN_SRC, 0o755);
const localBin = path.join(os.homedir(), ".local", "bin", "fantuan-browser");
ensureSymlink(BIN_SRC, localBin);
console.log(`Linked CLI:   ${localBin} -> ${BIN_SRC}`);

// 2. Install Skill into universal ~/.agents/skills (Codex / Claude Code / Orca)
const skillTargets = [
  path.join(os.homedir(), ".agents", "skills", "fantuan-browser"),
];

// Also link into Antigravity skills dir if present
const agySkillsDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "skills");
if (fs.existsSync(agySkillsDir)) {
  skillTargets.push(path.join(agySkillsDir, "fantuan-browser"));
}

for (const dest of skillTargets) {
  ensureSymlink(SKILL_SRC, dest);
  console.log(`Linked Skill: ${dest} -> ${SKILL_SRC}`);
}

console.log(`
Next step (one-time Chrome setup):
  1. Open chrome://extensions in Chrome
  2. Enable "Developer mode" (top right)
  3. Click "Load unpacked" and select:
     ${EXT_DIR}
  4. Verify connection:
     fantuan-browser status
`);
