#!/usr/bin/env node
// 把 co0ontty/wand-render 的 GitHub Release 资产同步成本仓库的产物目录与 manifest。
//
// 为什么由本仓库主动拉取，而不是源仓库推送过来：跨仓库推送需要 PAT（GITHUB_TOKEN 只能写
// 自己仓库），而拉取公开 Release 不需要任何凭据。于是整条链路零密钥 —— 源仓库构建并挂出资产，
// 本仓库用自己仓库的 GITHUB_TOKEN 提交。
//
// 用法：
//   node scripts/sync.mjs --version 0.1.1
//   node scripts/sync.mjs --version 0.1.1 --dry-run
//   node scripts/sync.mjs --version 0.1.1 --repo co0ontty/wand-render
//
// 幂等：内容与现有产物一致时不写任何文件。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_REPO = "co0ontty/wand-render";
const BINARY_NAME = "wand-render";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const options = { version: null, repo: DEFAULT_REPO, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version") options.version = String(argv[++i] ?? "").replace(/^v/, "");
    else if (arg === "--repo") options.repo = argv[++i];
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^\d+\.\d+\.\d+/.test(options.version ?? "")) throw new Error("--version 需要形如 0.1.1 的版本号");
  return options;
}

function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 下载公开 Release 资产；刻意不带任何凭据。 */
async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`下载失败 ${response.status} ${response.statusText}: ${url}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const base = `https://github.com/${options.repo}/releases/download/v${options.version}`;
  const work = mkdtempSync(path.join(os.tmpdir(), "wand-render-sync-"));

  try {
    process.stdout.write(`[sync] 源: ${base}\n`);
    const releaseManifestPath = path.join(work, "release-manifest.json");
    await download(`${base}/manifest.json`, releaseManifestPath);
    const release = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
    const entry = release.versions?.[options.version];
    if (!entry) throw new Error(`Release manifest 里没有版本 ${options.version}`);

    const triples = Object.keys(entry.triples ?? {}).sort();
    if (triples.length === 0) throw new Error(`Release manifest 里 ${options.version} 没有任何平台`);
    process.stdout.write(`[sync] 平台: ${triples.join(", ")}（协议 ${entry.protocolVersion}）\n`);

    const manifestPath = path.join(root, "manifest.json");
    const manifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, "utf8"))
      : { schemaVersion: 1, latest: options.version, versions: {} };
    if (manifest.schemaVersion !== 1) throw new Error(`不支持的 manifest schemaVersion ${manifest.schemaVersion}`);

    // 协议版本是硬契约：同一版本号内不允许漂移，变了就必须换版本号。
    const previous = manifest.versions[options.version];
    if (previous && previous.protocolVersion !== entry.protocolVersion) {
      throw new Error(`协议版本漂移：仓库 ${previous.protocolVersion} vs Release ${entry.protocolVersion}`);
    }

    const staged = [];
    for (const triple of triples) {
      const artifact = entry.triples[triple] ?? {};
      const expectedSha = String(artifact.sha256 ?? "").toLowerCase();
      if (!SHA256_PATTERN.test(expectedSha)) throw new Error(`${triple}: Release manifest 缺少合法 sha256`);

      const archive = path.join(work, `${triple}.tar.gz`);
      await download(`${base}/wand-render-${options.version}-${triple}.tar.gz`, archive);

      const extractDir = path.join(work, `extract-${triple}`);
      mkdirSync(extractDir, { recursive: true });
      execFileSync("tar", ["-xzf", archive, "-C", extractDir], { stdio: "inherit" });

      const extracted = path.join(extractDir, triple, BINARY_NAME);
      if (!existsSync(extracted)) throw new Error(`${triple}: 归档里没有 ${triple}/${BINARY_NAME}`);

      // 归档内容必须与 Release manifest 的哈希一致：这条把「下错/被篡改/打错包」都挡住。
      const actualSha = sha256Of(extracted);
      if (actualSha !== expectedSha) {
        throw new Error(`${triple}: 归档内容 sha256 与 manifest 不一致（${actualSha} != ${expectedSha}）`);
      }
      const actualSize = readFileSync(extracted).length;
      if (typeof artifact.size === "number" && actualSize !== artifact.size) {
        throw new Error(`${triple}: 尺寸与 manifest 不一致（${actualSize} != ${artifact.size}）`);
      }
      let structured = null;
      if (artifact.structured) {
        const metadata = artifact.structured;
        const filename = "wand-structured-renderd";
        const binary = path.join(extractDir, triple, filename);
        const expected = String(metadata.sha256 ?? "").toLowerCase();
        if (!SHA256_PATTERN.test(expected) || !existsSync(binary)) {
          throw new Error(`${triple}: structured binary or its sha256 is missing`);
        }
        const actual = sha256Of(binary);
        const size = readFileSync(binary).length;
        if (actual !== expected || size !== metadata.size || metadata.protocolVersion !== 2) {
          throw new Error(`${triple}: structured binary integrity/protocol check failed`);
        }
        structured = { filename, binary, sha256: actual, size, protocolVersion: 2 };
      }

      const targetDir = path.join(root, `v${options.version}`, triple);
      const target = path.join(targetDir, BINARY_NAME);
      const unchanged = existsSync(target) && sha256Of(target) === actualSha;
      process.stdout.write(
        `[sync] ${triple}: ${actualSize} bytes, sha256 ${actualSha.slice(0, 12)}…`
        + `${unchanged ? "（已一致）" : ""}${options.dryRun ? " [dry-run]" : ""}\n`,
      );

      if (!options.dryRun) {
        mkdirSync(targetDir, { recursive: true });
        if (!unchanged) {
          copyFileSync(extracted, target);
          chmodSync(target, 0o755);
        }
        if (structured) {
          const structuredTarget = path.join(targetDir, structured.filename);
          if (!existsSync(structuredTarget) || sha256Of(structuredTarget) !== structured.sha256) {
            copyFileSync(structured.binary, structuredTarget);
            chmodSync(structuredTarget, 0o755);
          }
        }
        // Repair missing sidecars, but leave matching files untouched so an
        // identical sync does not create a spurious manifest/binary commit.
        for (const [name, value] of [
          [`${BINARY_NAME}.version`, `${options.version}\n`],
          [`${BINARY_NAME}.sha256`, `${actualSha}  ${BINARY_NAME}\n`],
          ...(structured ? [
            [`${structured.filename}.version`, `${options.version}\n`],
            [`${structured.filename}.sha256`, `${structured.sha256}  ${structured.filename}\n`],
          ] : []),
        ]) {
          const sidecar = path.join(targetDir, name);
          if (!existsSync(sidecar) || readFileSync(sidecar, "utf8") !== value) writeFileSync(sidecar, value);
        }
      }

      staged.push({
        triple,
        path: `v${options.version}/${triple}/${BINARY_NAME}`,
        sha256: actualSha,
        size: actualSize,
        rustTarget: artifact.rustTarget,
        ...(structured ? { structured: {
          path: `v${options.version}/${triple}/${structured.filename}`,
          sha256: structured.sha256, size: structured.size,
          protocolVersion: structured.protocolVersion,
        } } : {}),
      });
    }

    const mergedTriples = Object.fromEntries(staged.map((item) => [item.triple, {
      path: item.path,
      sha256: item.sha256,
      size: item.size,
      ...(item.rustTarget ? { rustTarget: item.rustTarget } : {}),
      ...(item.structured ? { structured: item.structured } : {}),
    }]));
    // 保留既有版本里本次没同步的平台（先发 darwin、后补 linux 时不要把它们删掉）。
    for (const [triple, artifact] of Object.entries(previous?.triples ?? {})) {
      if (!mergedTriples[triple]) mergedTriples[triple] = artifact;
    }

    const nextManifest = {
      schemaVersion: 1,
      latest: manifest.latest && manifest.latest > options.version ? manifest.latest : options.version,
      versions: {
        ...manifest.versions,
        [options.version]: {
          protocolVersion: entry.protocolVersion,
          minServerVersion: entry.minServerVersion,
          triples: Object.fromEntries(Object.entries(mergedTriples).sort(([a], [b]) => a.localeCompare(b))),
        },
      },
    };

    const before = JSON.stringify(manifest);
    const after = JSON.stringify(nextManifest);
    if (before === after) {
      process.stdout.write("[sync] manifest 无变化\n");
    } else if (options.dryRun) {
      process.stdout.write("[sync] manifest 将更新 [dry-run]\n");
    } else {
      writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
      process.stdout.write(`[sync] manifest 已更新：${options.version} -> ${Object.keys(mergedTriples).join(", ")}\n`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
