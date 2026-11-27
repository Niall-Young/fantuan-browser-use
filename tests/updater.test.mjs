import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  applyReleaseUpdate,
  checkForUpdate,
  compareSemver,
  normalizeVersion,
} from "../src/updater.mjs";

test("normalizeVersion and compareSemver handle v-prefixes and semver order", () => {
  assert.equal(normalizeVersion("v1.2.3"), "1.2.3");
  assert.equal(compareSemver("0.1.0", "0.2.0"), -1);
  assert.equal(compareSemver("0.2.0", "v0.2.0"), 0);
  assert.equal(compareSemver("1.0.0", "0.9.9"), 1);
  assert.equal(compareSemver("0.2.0-beta.1", "0.2.0"), -1);
});

test("checkForUpdate reports update availability and handles 404", async () => {
  const mockFetchNew = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: "v0.2.0",
      name: "v0.2.0",
      html_url: "https://github.com/Niall-Young/fantuan-browser-use/releases/tag/v0.2.0",
      published_at: "2026-11-27T00:00:00Z",
      tarball_url: "https://example.invalid/v0.2.0.tar.gz",
    }),
  });

  const res = await checkForUpdate({
    repo: "Niall-Young/fantuan-browser-use",
    currentVersion: "0.1.0",
    fetchImpl: mockFetchNew,
  });
  assert.equal(res.updateAvailable, true);
  assert.equal(res.latestVersion, "0.2.0");
  assert.equal(res.tagName, "v0.2.0");

  const upToDate = await checkForUpdate({
    repo: "Niall-Young/fantuan-browser-use",
    currentVersion: "0.2.0",
    fetchImpl: mockFetchNew,
  });
  assert.equal(upToDate.updateAvailable, false);

  const mockFetch404 = async () => ({ ok: false, status: 404, text: async () => "" });
  await assert.rejects(
    () =>
      checkForUpdate({
        repo: "Niall-Young/fantuan-browser-use",
        currentVersion: "0.1.0",
        fetchImpl: mockFetch404,
      }),
    /No GitHub Release found/
  );
});

test("applyReleaseUpdate extracts release tarball, swaps installDir, and stops daemon", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fantuan-updater-test-"));
  const releaseSrc = path.join(workDir, "fantuan-browser-use-0.2.0");
  const installDir = path.join(workDir, "installed-app");
  const tarballPath = path.join(workDir, "release.tar.gz");

  try {
    // Build a fake release archive matching GitHub's tarball structure
    fs.mkdirSync(path.join(releaseSrc, "bin"), { recursive: true });
    fs.mkdirSync(path.join(releaseSrc, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(releaseSrc, "package.json"),
      JSON.stringify({ name: "fantuan-browser-use", version: "0.2.0" })
    );
    fs.writeFileSync(
      path.join(releaseSrc, "bin", "fantuan-browser"),
      "#!/usr/bin/env node\nconsole.log('0.2.0');\n"
    );
    fs.writeFileSync(
      path.join(releaseSrc, "src", "cli.mjs"),
      "export const version = '0.2.0';\n"
    );

    execFileSync("tar", ["-czf", tarballPath, "-C", workDir, "fantuan-browser-use-0.2.0"]);
    const tarballBytes = fs.readFileSync(tarballPath);

    // Seed an existing older installDir to verify atomic swap
    fs.mkdirSync(path.join(installDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(installDir, "src", "old.mjs"), "old");

    let daemonStopCalled = false;
    const mockFetch = async (url) => {
      if (url.includes("/releases/latest")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: "v0.2.0",
            html_url: "https://github.com/Niall-Young/fantuan-browser-use/releases/tag/v0.2.0",
            tarball_url: "https://example.invalid/release.tar.gz",
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => tarballBytes,
      };
    };

    const result = await applyReleaseUpdate({
      repo: "Niall-Young/fantuan-browser-use",
      currentVersion: "0.1.0",
      installDir,
      ensureBinLink: false,
      fetchImpl: mockFetch,
      stopDaemonFn: async () => {
        daemonStopCalled = true;
        return { stopped: true };
      },
    });

    assert.equal(result.updated, true);
    assert.equal(result.latestVersion, "0.2.0");
    assert.equal(result.daemonStopped, true);
    assert.equal(daemonStopCalled, true);

    const installedPkg = JSON.parse(
      fs.readFileSync(path.join(installDir, "package.json"), "utf8")
    );
    assert.equal(installedPkg.version, "0.2.0");
    assert.equal(fs.existsSync(path.join(installDir, "src", "old.mjs")), false);
    const binMode = fs.statSync(path.join(installDir, "bin", "fantuan-browser")).mode & 0o111;
    assert.ok(binMode !== 0, "bin/fantuan-browser should be executable");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
