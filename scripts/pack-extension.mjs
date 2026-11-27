#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EXT_DIR = path.join(REPO_ROOT, "extension");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const MANIFEST_PATH = path.join(EXT_DIR, "manifest.json");

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const version = manifest.version;
if (!version) {
  console.error("Error: extension/manifest.json is missing a version field.");
  process.exit(1);
}

// Verify required files referenced by manifest.json exist
const requiredFiles = [
  "manifest.json",
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
].filter(Boolean);

for (const rel of new Set(requiredFiles)) {
  const fullPath = path.join(EXT_DIR, rel);
  if (!fs.existsSync(fullPath)) {
    console.error(`Error: missing required extension file: extension/${rel}`);
    process.exit(1);
  }
}

fs.mkdirSync(DIST_DIR, { recursive: true });
const outFile = path.join(DIST_DIR, `fantuan-browser-bridge-v${version}.zip`);

if (fs.existsSync(outFile)) {
  fs.unlinkSync(outFile);
}

// Package from inside extension/ so manifest.json sits at the zip root (required by Chrome Web Store)
execFileSync(
  "zip",
  [
    "-r",
    "-X",
    outFile,
    ".",
    "-x",
    "*.DS_Store",
    "__MACOSX/*",
    "*.map",
    "*.git*",
  ],
  { cwd: EXT_DIR, stdio: "inherit" }
);

const stat = fs.statSync(outFile);
console.log(`\nPackaged Chrome Web Store zip:`);
console.log(`  Path: ${outFile}`);
console.log(`  Size: ${(stat.size / 1024).toFixed(1)} KB`);
