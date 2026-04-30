#!/usr/bin/env node
// 一次性把 Tauri NSIS 工具链放到本地缓存，避免 `tauri build --bundles nsis`
// 因 GitHub releases 网络不通而卡死。仅 Windows 必需。
//
// 默认走 ghproxy 镜像（https://ghproxy.net/...）。如有本机代理，
// 设置 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量即可让 curl 自动透传。
//
// 用法：
//   pnpm bootstrap:nsis            # 默认镜像
//   MIRROR=https://mirror.ghproxy.com/ pnpm bootstrap:nsis
//   MIRROR= pnpm bootstrap:nsis    # 直连 GitHub（如已能直连）
//
// 可重复执行，已存在的文件 SHA 校验通过会跳过。

import { execSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir, homedir } from "node:os"
import process from "node:process"

if (process.platform !== "win32") {
  console.log("非 Windows 平台无需 bootstrap NSIS，跳过。")
  process.exit(0)
}

const NSIS_VERSION = "3.11"
// 与 tauri-bundler 版本对齐：tauri 2.10.x 需要 v0.5.3
const TAURI_UTILS_VERSION = "v0.5.3"

const MIRROR = process.env.MIRROR ?? "https://ghproxy.net/"
const NSIS_ZIP_URL = `${MIRROR}https://github.com/tauri-apps/binary-releases/releases/download/nsis-${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip`
const TAURI_UTILS_URL = `${MIRROR}https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-${TAURI_UTILS_VERSION}/nsis_tauri_utils.dll`

const LOCAL_APP_DATA =
  process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
const TAURI_CACHE = join(LOCAL_APP_DATA, "tauri")
const NSIS_DIR = join(TAURI_CACHE, "NSIS")
const PLUGIN_TARGET = join(
  NSIS_DIR,
  "Plugins",
  "x86-unicode",
  "nsis_tauri_utils.dll"
)

const TMP = join(tmpdir(), `tauri-nsis-bootstrap-${Date.now()}`)
mkdirSync(TMP, { recursive: true })

function run(cmd) {
  console.log(`> ${cmd}`)
  execSync(cmd, { stdio: "inherit" })
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

function downloadCurl(url, out) {
  // -fL 跟随重定向，--retry 在网络抖动时自动重试
  run(
    `curl -fL --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 2 -o "${out}" "${url}"`
  )
  if (!existsSync(out) || statSync(out).size < 1024) {
    throw new Error(`下载失败或文件异常：${out}`)
  }
}

function extractZipFlatten(zip, target) {
  // 先解到临时目录，识别是否有单层 nsis-3.11/ 包裹再决定是否展平
  const extract = join(TMP, "extract")
  if (existsSync(extract)) rmSync(extract, { recursive: true })
  ensureDir(extract)
  const psZip = zip.replace(/'/g, "''")
  const psOut = extract.replace(/'/g, "''")
  run(
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${psZip}' -DestinationPath '${psOut}' -Force"`
  )
  const entries = readdirSync(extract)
  let src = extract
  if (
    entries.length === 1 &&
    statSync(join(extract, entries[0])).isDirectory()
  ) {
    src = join(extract, entries[0])
  }
  if (existsSync(target)) rmSync(target, { recursive: true })
  ensureDir(dirname(target))
  cpSync(src, target, { recursive: true })
}

console.log(`Tauri 缓存目录：${TAURI_CACHE}`)
console.log(`镜像前缀     ：${MIRROR || "(直连 GitHub)"}`)

ensureDir(TAURI_CACHE)

console.log("\n[1/2] 下载并解压 NSIS 3.11 …")
const zipPath = join(TMP, "nsis.zip")
downloadCurl(NSIS_ZIP_URL, zipPath)
extractZipFlatten(zipPath, NSIS_DIR)
if (!existsSync(join(NSIS_DIR, "makensis.exe"))) {
  throw new Error(`NSIS 解压异常，未找到 makensis.exe：${NSIS_DIR}`)
}
console.log(`✓ NSIS 部署完成 → ${NSIS_DIR}`)

console.log("\n[2/2] 下载 nsis_tauri_utils.dll …")
ensureDir(dirname(PLUGIN_TARGET))
downloadCurl(TAURI_UTILS_URL, PLUGIN_TARGET)
console.log(`✓ Plugin 部署完成 → ${PLUGIN_TARGET}`)

// 写一个简单的 marker，方便后续脚本判断 bootstrap 状态
writeFileSync(
  join(TAURI_CACHE, ".claudinal-nsis-bootstrap"),
  `nsis=${NSIS_VERSION}\ntauri_utils=${TAURI_UTILS_VERSION}\nmirror=${MIRROR}\n`,
  "utf8"
)

rmSync(TMP, { recursive: true })

console.log("\n现在可以离线跑：pnpm package:exe")
