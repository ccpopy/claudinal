#!/usr/bin/env node
// 把 tauri 构建产物打成 zip 输出到 dist 同级的 release/ 目录。
//   - <productName>-<version>-setup.zip    : 内含 NSIS 安装引导 exe
//   - <productName>-<version>-portable.zip : 内含可直接运行的 exe（绿色版）
//
// 用法：
//   pnpm package:zip               # 同时输出两个 zip（缺哪个跳过哪个）
//   pnpm package:zip installer     # 仅打安装引导 zip
//   pnpm package:zip portable      # 仅打便携版 zip
//
// 前置：
//   - portable 需要 src-tauri/target/release/<bin>.exe（cargo build --release 或 tauri build 产出）
//   - installer 需要 src-tauri/target/release/bundle/nsis/*.exe（tauri build --bundles nsis 产出）

import { execSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")
const RELEASE = join(ROOT, "release")
const STAGING = join(RELEASE, "_staging")
const TARGET_DIR = join(ROOT, "src-tauri", "target", "release")
const NSIS_DIR = join(TARGET_DIR, "bundle", "nsis")

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const tauriConf = JSON.parse(
  readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")
)
const cargoToml = readFileSync(
  join(ROOT, "src-tauri", "Cargo.toml"),
  "utf8"
)
const cargoBinName =
  cargoToml.match(/^\s*default-run\s*=\s*"([^"]+)"/m)?.[1] ??
  cargoToml.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ??
  "claudecli-desktop"

const VERSION = pkg.version
const PRODUCT = (tauriConf.productName ?? pkg.name ?? "App").replace(/\s+/g, "-")

const mode = (process.argv[2] ?? "all").toLowerCase()
if (!["all", "installer", "portable"].includes(mode)) {
  console.error(`未知模式：${mode}。可选：all | installer | portable`)
  process.exit(2)
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

function findFirst(dir, predicate) {
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir)) {
    if (predicate(name)) return join(dir, name)
  }
  return null
}

function zipFolder(srcDir, outZip) {
  if (existsSync(outZip)) rmSync(outZip)
  if (process.platform === "win32") {
    const psSrc = srcDir.replace(/'/g, "''")
    const psOut = outZip.replace(/'/g, "''")
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '${psSrc}\\*' -DestinationPath '${psOut}' -Force"`,
      { stdio: "inherit" }
    )
  } else {
    execSync(`cd "${srcDir}" && zip -r -9 "${outZip}" .`, {
      stdio: "inherit",
      shell: "/bin/bash"
    })
  }
}

ensureDir(RELEASE)
if (existsSync(STAGING)) rmSync(STAGING, { recursive: true })

let didInstaller = false
let didPortable = false

if (mode === "all" || mode === "installer") {
  const installer = findFirst(
    NSIS_DIR,
    (n) => n.toLowerCase().endsWith("-setup.exe") && !n.startsWith(".")
  )
  if (!installer) {
    const hint = `未找到安装引导 exe，跳过。先跑 \`pnpm package:exe\` 产出 NSIS 安装包到 ${NSIS_DIR}`
    if (mode === "installer") {
      console.error(hint)
      process.exit(1)
    } else {
      console.warn(`! ${hint}`)
    }
  } else {
    const stage = join(STAGING, "installer")
    ensureDir(stage)
    cpSync(installer, join(stage, basename(installer)))
    const out = join(RELEASE, `${PRODUCT}-${VERSION}-setup.zip`)
    zipFolder(stage, out)
    console.log(`✓ 安装引导 zip：${out}`)
    didInstaller = true
  }
}

if (mode === "all" || mode === "portable") {
  const ext = process.platform === "win32" ? ".exe" : ""
  const exePath = join(TARGET_DIR, `${cargoBinName}${ext}`)
  if (!existsSync(exePath)) {
    const hint = `未找到主程序：${exePath}。先跑 \`pnpm package:exe\` 或 \`cargo build --release\``
    if (mode === "portable") {
      console.error(hint)
      process.exit(1)
    } else {
      console.warn(`! ${hint}，跳过 portable`)
    }
  } else {
    const stage = join(STAGING, "portable")
    ensureDir(stage)
    cpSync(exePath, join(stage, `${PRODUCT}${ext}`))
    const readme = `# ${PRODUCT} ${VERSION} (Portable)\n\n双击 ${PRODUCT}${ext} 即可运行，无需安装。\n配置写入：%APPDATA%\\com.claudinal.desktop（Windows）/ ~/Library/Application Support/com.claudinal.desktop（macOS）/ ~/.config/com.claudinal.desktop（Linux）。\n`
    const fs = await import("node:fs/promises")
    await fs.writeFile(join(stage, "README.txt"), readme, "utf8")
    const out = join(RELEASE, `${PRODUCT}-${VERSION}-portable.zip`)
    zipFolder(stage, out)
    console.log(`✓ 便携版 zip：${out}`)
    didPortable = true
  }
}

if (existsSync(STAGING)) rmSync(STAGING, { recursive: true })

if (!didInstaller && !didPortable) {
  console.error("没有产出任何 zip，请先确认构建产物存在。")
  process.exit(1)
}
