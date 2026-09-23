#!/usr/bin/env node
// 按 minor 版本保留最近 N 个，其余版本目录删除并同步 manifest。
//
// 用法：node scripts/prune.js --keep 3 [--dry-run]
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const options = { keep: 3, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keep") options.keep = Number(argv[++i]);
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.keep) || options.keep < 1) throw new Error("--keep must be a positive integer");
  return options;
}

/** 取 minor 键（major.minor）；patch 版本共享同一档，避免把仍在用的补丁版删掉。 */
function minorKey(version) {
  const [major, minor] = String(version).split(".");
  return `${major}.${minor}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const versions = Object.keys(manifest.versions);
  if (versions.length === 0) {
    process.stdout.write("[prune] manifest has no versions; nothing to do\n");
    return;
  }

  const minors = [...new Set(versions.map(minorKey))].sort((a, b) => {
    const [aMajor, aMinor] = a.split(".").map(Number);
    const [bMajor, bMinor] = b.split(".").map(Number);
    return aMajor - bMajor || aMinor - bMinor;
  });
  const keepMinors = new Set(minors.slice(-options.keep));
  // latest 永远保留：安装脚本按它做版本比较。
  const keepVersions = new Set(versions.filter((version) => keepMinors.has(minorKey(version))));
  if (manifest.latest) keepVersions.add(manifest.latest);
  const dropVersions = versions.filter((version) => !keepVersions.has(version));

  if (dropVersions.length === 0) {
    process.stdout.write(`[prune] keeping ${[...keepVersions].join(", ")}; nothing to drop\n`);
    return;
  }
  for (const version of dropVersions) {
    const dir = path.join(root, `v${version}`);
    process.stdout.write(`[prune] drop v${version}${options.dryRun ? " (dry-run)" : ""}\n`);
    if (options.dryRun) continue;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    delete manifest.versions[version];
  }
  if (options.dryRun) return;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`[prune] manifest now has ${Object.keys(manifest.versions).join(", ") || "(none)"}\n`);
}

main();
