#!/usr/bin/env node
/**
 * Resolves the next release version and keeps package.json, package-lock.json,
 * src-tauri/tauri.conf.json, src-tauri/Cargo.toml, and src-tauri/Cargo.lock in sync.
 *
 * Usage:
 *   node scripts/bump-version.mjs [--mode auto|patch|minor|major|none] [--tag v0.4.0] [--dry-run]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function parseVersion(raw) {
  const match = SEMVER_RE.exec(String(raw).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function formatVersion([major, minor, patch]) {
  return `${major}.${minor}.${patch}`;
}

function parseArgs(argv) {
  const opts = { mode: "auto", tag: "", dryRun: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1]) {
      opts.mode = argv[++i];
    } else if (arg === "--tag" && argv[i + 1]) {
      opts.tag = argv[++i];
    } else if (arg === "--root" && argv[i + 1]) {
      opts.root = path.resolve(argv[++i]);
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["auto", "patch", "minor", "major", "none"].includes(opts.mode)) {
    throw new Error(`Unsupported --mode "${opts.mode}"`);
  }
  return opts;
}

function existingTags(root) {
  if (process.env.RELEASE_TAGS !== undefined) {
    return process.env.RELEASE_TAGS.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  const output = execFileSync("git", ["tag", "-l", "v*"], { cwd: root, encoding: "utf8" });
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function resolveTargetVersion(currentStr, tags, mode, explicitTag) {
  if (explicitTag) {
    const stripped = explicitTag.replace(/^v/, "").trim();
    if (!parseVersion(stripped)) {
      throw new Error(`Explicit tag "${explicitTag}" is not a valid semver tag`);
    }
    return stripped;
  }

  const current = parseVersion(currentStr);
  if (!current) {
    throw new Error(`Current package.json version "${currentStr}" is not valid semver`);
  }

  const parsedTags = tags
    .map((tag) => ({ tag, parsed: parseVersion(tag) }))
    .filter((entry) => entry.parsed !== null);

  let highest = null;
  for (const entry of parsedTags) {
    if (!highest || compareVersions(entry.parsed, highest) > 0) {
      highest = entry.parsed;
    }
  }

  const base = highest && compareVersions(highest, current) > 0 ? highest : current;

  if (mode === "none") return formatVersion(current);
  if (mode === "major") return formatVersion([base[0] + 1, 0, 0]);
  if (mode === "minor") return formatVersion([base[0], base[1] + 1, 0]);
  if (mode === "patch") return formatVersion([base[0], base[1], base[2] + 1]);

  // mode === "auto": respect an unreleased manual bump above the latest tag; otherwise bump patch.
  const currentTagExists = tags.includes(`v${formatVersion(current)}`);
  if (!currentTagExists && (!highest || compareVersions(current, highest) > 0)) {
    return formatVersion(current);
  }
  return formatVersion([base[0], base[1], base[2] + 1]);
}

function updateJsonFile(filePath, mutator, dryRun) {
  const before = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(before);
  mutator(parsed);
  const after = `${JSON.stringify(parsed, null, 2)}\n`;
  if (after === before) return false;
  if (!dryRun) fs.writeFileSync(filePath, after, "utf8");
  return true;
}

function updateTextFile(filePath, replacer, dryRun) {
  const before = fs.readFileSync(filePath, "utf8");
  const after = replacer(before);
  if (after === before) return false;
  if (!dryRun) fs.writeFileSync(filePath, after, "utf8");
  return true;
}

function syncVersionFiles(root, targetVersion, dryRun) {
  let changed = false;

  changed = updateJsonFile(
    path.join(root, "package.json"),
    (pkg) => { pkg.version = targetVersion; },
    dryRun,
  ) || changed;

  const lockPath = path.join(root, "package-lock.json");
  if (fs.existsSync(lockPath)) {
    changed = updateJsonFile(
      lockPath,
      (lock) => {
        lock.version = targetVersion;
        if (lock.packages && lock.packages[""]) {
          lock.packages[""].version = targetVersion;
        }
      },
      dryRun,
    ) || changed;
  }

  changed = updateJsonFile(
    path.join(root, "src-tauri", "tauri.conf.json"),
    (conf) => { conf.version = targetVersion; },
    dryRun,
  ) || changed;

  changed = updateTextFile(
    path.join(root, "src-tauri", "Cargo.toml"),
    (text) => {
      const updated = text.replace(
        /(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
        `$1${targetVersion}$2`,
      );
      if (updated === text && !text.includes(`version = "${targetVersion}"`)) {
        throw new Error("Could not locate [package] version in src-tauri/Cargo.toml");
      }
      return updated;
    },
    dryRun,
  ) || changed;

  const cargoLockPath = path.join(root, "src-tauri", "Cargo.lock");
  if (fs.existsSync(cargoLockPath)) {
    changed = updateTextFile(
      cargoLockPath,
      (text) => text.replace(
        /(name\s*=\s*"hush-type"\r?\nversion\s*=\s*")[^"]+(")/,
        `$1${targetVersion}$2`,
      ),
      dryRun,
    ) || changed;
  }

  return changed;
}

const opts = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(fs.readFileSync(path.join(opts.root, "package.json"), "utf8"));
const tags = existingTags(opts.root);
const version = resolveTargetVersion(pkg.version, tags, opts.mode, opts.tag);
const changed = syncVersionFiles(opts.root, version, opts.dryRun);

process.stdout.write(`${JSON.stringify({ version, tag: `v${version}`, changed })}\n`);
