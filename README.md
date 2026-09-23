# wand-render-bin

`co0ontty/wand-render` 构建出的**平台产物**。这里只放可执行文件与清单，不放源码。

> 本仓库内容全部由 CI 生成（`wand-render/.github/workflows/release.yml`）。
> 手工改这里的文件会在下一次发版时被覆盖。

## 目录约定

```text
manifest.json                                   # 版本 → 平台 → sha256/size 的唯一索引
v<version>/<triple>/wand-render                 # 可执行文件（0755）
v<version>/<triple>/wand-render.version         # 版本号文本
v<version>/<triple>/wand-render.sha256          # shasum -a 256 输出
```

`<triple>` ∈ `darwin-arm64` `darwin-x64` `linux-x64` `linux-arm64`（`win32-x64` 预留未实现）。

## manifest.json

```json
{
  "schemaVersion": 1,
  "latest": "0.1.0",
  "versions": {
    "0.1.0": {
      "protocolVersion": 1,
      "minServerVersion": "4.73.0",
      "triples": {
        "darwin-arm64": { "path": "v0.1.0/darwin-arm64/wand-render",
                          "sha256": "…", "size": 820336, "rustTarget": "aarch64-apple-darwin" }
      }
    }
  }
}
```

`protocolVersion` 是 Render 与 Server 的硬契约版本：不匹配时 Server 拒绝启动，不做降级运行。
`minServerVersion` 是该二进制要求的最低 Server 版本。

## 为什么把二进制提交进 git

1. **离线确定性**：主仓库 npm 包内直接内嵌二进制，安装不需要网络，也不需要用户装 Rust。
2. **子模块即版本锁**：主仓库把本仓库 pin 到某个提交，发出去的 npm 包与本地构建完全同源。
3. **可校验**：每个文件都有 sha256，主仓库 stage 时逐个核对，杜绝「打包了个 stub 进去」。
4. **git 传输不带 quarantine 扩展属性**：macOS 上从 git 取出的二进制不会被 Gatekeeper 拦（浏览器下载的才会）。

## 保留策略

只保留最近 3 个 minor 版本与当前 `latest`，更旧的目录随 tag 一起删除以控制仓库体积：

```bash
node scripts/prune.js --keep 3 --dry-run
```

## 消费方式（主仓库 co0ontty/wand）

```bash
git submodule update --init render-bin        # pin 到某个提交
npm run build                                  # 校验 sha256 后 stage 到 dist/native/<triple>/
```
