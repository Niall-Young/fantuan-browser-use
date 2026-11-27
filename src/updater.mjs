import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getInstallDir, getLocalVersion, getPort, getRepo } from "./config.mjs";
import { stopDaemon } from "./client.mjs";

export function normalizeVersion(raw) {
  return String(raw || "")
    .trim()
    .replace(/^v/i, "");
}

export function compareSemver(a, b) {
  const parse = (v) => {
    const clean = normalizeVersion(v);
    const [core, pre = ""] = clean.split("-", 2);
    const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return { parts, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] !== pb.parts[i]) {
      return pa.parts[i] > pb.parts[i] ? 1 : -1;
    }
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

function buildHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "fantuan-browser-cli",
  };
  const authToken = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return headers;
}

export async function fetchLatestRelease(options = {}) {
  const repo = options.repo || getRepo();
  const fetchImpl = options.fetchImpl || fetch;
  const headers = buildHeaders(options.token);
  const url = `https://api.github.com/repos/${repo}/releases/latest`;

  const res = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 404) {
    throw new Error(
      `No GitHub Release found for ${repo} yet. Publish a release tag (e.g. v0.2.0) on GitHub first.`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GitHub API request failed (${res.status}) for ${repo}: ${text.slice(0, 200)}`
    );
  }

  const data = await res.json();
  const tagName = data.tag_name || "";
  const version = normalizeVersion(tagName);
  if (!version || !data.tarball_url) {
    throw new Error(`Invalid release payload returned by GitHub for ${repo}`);
  }

  return {
    repo,
    tagName,
    version,
    name: data.name || tagName,
    htmlUrl: data.html_url || `https://github.com/${repo}/releases/tag/${tagName}`,
    publishedAt: data.published_at || null,
    tarballUrl: data.tarball_url,
  };
}

export async function checkForUpdate(options = {}) {
  const currentVersion = normalizeVersion(options.currentVersion || getLocalVersion());
  const release = await fetchLatestRelease(options);
  const updateAvailable = compareSemver(currentVersion, release.version) < 0;

  return {
    repo: release.repo,
    currentVersion,
    latestVersion: release.version,
    tagName: release.tagName,
    updateAvailable,
    htmlUrl: release.htmlUrl,
    publishedAt: release.publishedAt,
    tarballUrl: release.tarballUrl,
  };
}

function findExtractedRoot(extractDir) {
  const entries = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const entry of entries) {
    const candidate = path.join(extractDir, entry.name);
    if (
      fs.existsSync(path.join(candidate, "package.json")) &&
      fs.existsSync(path.join(candidate, "bin", "fantuan-browser")) &&
      fs.existsSync(path.join(candidate, "src", "cli.mjs"))
    ) {
      return candidate;
    }
  }

  if (
    fs.existsSync(path.join(extractDir, "package.json")) &&
    fs.existsSync(path.join(extractDir, "bin", "fantuan-browser")) &&
    fs.existsSync(path.join(extractDir, "src", "cli.mjs"))
  ) {
    return extractDir;
  }

  throw new Error("Release archive is missing expected CLI files (package.json, bin/, src/)");
}

function ensureLocalBinLink(installDir) {
  const localBin = path.join(os.homedir(), ".local", "bin", "fantuan-browser");
  const target = path.join(installDir, "bin", "fantuan-browser");
  fs.mkdirSync(path.dirname(localBin), { recursive: true });
  try {
    const stat = fs.lstatSync(localBin);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(localBin);
    }
  } catch {
    // does not exist
  }
  fs.symlinkSync(target, localBin);
}

export async function applyReleaseUpdate(options = {}) {
  const check = await checkForUpdate(options);
  if (options.checkOnly) {
    return { ...check, updated: false };
  }
  if (!check.updateAvailable && !options.force) {
    return { ...check, updated: false, reason: "already up to date" };
  }

  const installDir = path.resolve(options.installDir || getInstallDir());
  const fetchImpl = options.fetchImpl || fetch;
  const headers = buildHeaders(options.token);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fantuan-update-"));
  const tarballPath = path.join(tmpDir, "release.tar.gz");
  const extractDir = path.join(tmpDir, "extract");
  const stagingDir = `${installDir}.staging.${Date.now()}`;
  const backupDir = `${installDir}.bak.${Date.now()}`;

  try {
    const res = await fetchImpl(check.tarballUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to download release tarball (${res.status})`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tarballPath, buf);
    fs.mkdirSync(extractDir, { recursive: true });

    execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
      stdio: "pipe",
    });

    const extractedRoot = findExtractedRoot(extractDir);

    fs.mkdirSync(path.dirname(installDir), { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.cpSync(path.join(extractedRoot, "package.json"), path.join(stagingDir, "package.json"));
    fs.cpSync(path.join(extractedRoot, "bin"), path.join(stagingDir, "bin"), {
      recursive: true,
    });
    fs.cpSync(path.join(extractedRoot, "src"), path.join(stagingDir, "src"), {
      recursive: true,
    });
    fs.chmodSync(path.join(stagingDir, "bin", "fantuan-browser"), 0o755);

    const hadExisting = fs.existsSync(installDir);
    if (hadExisting) {
      fs.renameSync(installDir, backupDir);
    }
    try {
      fs.renameSync(stagingDir, installDir);
    } catch (err) {
      if (hadExisting && fs.existsSync(backupDir) && !fs.existsSync(installDir)) {
        fs.renameSync(backupDir, installDir);
      }
      throw err;
    }

    if (hadExisting && fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }

    if (options.ensureBinLink !== false) {
      ensureLocalBinLink(installDir);
    }

    const stopFn = options.stopDaemonFn || stopDaemon;
    const stopResult = await stopFn(options.port || getPort()).catch(() => ({
      stopped: false,
    }));

    return {
      ...check,
      updated: true,
      installDir,
      daemonStopped: Boolean(stopResult?.stopped),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}
