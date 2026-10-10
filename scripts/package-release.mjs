#!/usr/bin/env node
// 把 tauri 构建产物打成 zip 输出到 dist 同级的 release/ 目录。
//   - <productName>-<version>-setup.zip    : 内含 NSIS 安装引导 exe
//   - <productName>-<version>-portable.zip : 内含可直接运行的 exe（绿色版）
//
// 用法：
//   pnpm package:zip               # 当前版本安装器与便携版 zip
//   pnpm package:zip-installer     # 仅打安装引导 zip
//   pnpm package:zip-portable      # 仅打便携版 zip
//
// 前置：
//   - portable 需要 Cargo 有效 target 下 release/<bin>.exe（必须由 tauri build --no-bundle 或 tauri build 产出）
//     不要用裸 cargo build --release；它会生成指向 devUrl 的开发服务器版本。
//   - installer 需要该 target 下当前产品/版本的唯一 NSIS 安装器（tauri build --bundles nsis 产出）

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
import { selectNsisInstaller } from "./release-artifacts.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")
const RELEASE = join(ROOT, "release")
const STAGING = join(RELEASE, "_staging")
const TAURI_ROOT = join(ROOT, "src-tauri")

function cargoTargetRoot() {
  try {
    const metadata = JSON.parse(
      execSync("cargo metadata --format-version 1 --no-deps", {
        cwd: TAURI_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      })
    )
    if (typeof metadata.target_directory === "string") {
      return resolve(metadata.target_directory)
    }
  } catch {
    // Keep the repository-local default for environments that package an
    // existing artifact without Cargo on PATH.
  }
  return join(TAURI_ROOT, "target")
}

const TARGET_DIR = join(cargoTargetRoot(), "release")
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
const BUNDLE_PRODUCT = tauriConf.productName ?? pkg.name ?? "App"
const PRODUCT = BUNDLE_PRODUCT.replace(/\s+/g, "-")

const mode = (process.argv[2] ?? "all").toLowerCase()
if (!["all", "installer", "portable"].includes(mode)) {
  console.error(`未知模式：${mode}。可选：all | installer | portable`)
  process.exit(2)
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
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

// Validate the installer before writing staging/output. Never accept a stale
// or unrelated installer merely because it was enumerated first.
let installer = null
if (mode === "all" || mode === "installer") {
  try {
    const names = existsSync(NSIS_DIR)
      ? readdirSync(NSIS_DIR, { withFileTypes: true })
          .filter((entry) => entry.isFile()).map((entry) => entry.name)
      : []
    installer = join(NSIS_DIR, selectNsisInstaller(names, BUNDLE_PRODUCT, VERSION))
  } catch (error) {
    console.error(`${error.message}。先跑 \`pnpm package:exe\`，产物目录：${NSIS_DIR}`)
    process.exit(1)
  }
}

ensureDir(RELEASE)
if (existsSync(STAGING)) rmSync(STAGING, { recursive: true })

let didInstaller = false
let didPortable = false

if (installer) {
  const stage = join(STAGING, "installer")
  ensureDir(stage)
  cpSync(installer, join(stage, basename(installer)))
  const out = join(RELEASE, `${PRODUCT}-${VERSION}-setup.zip`)
  zipFolder(stage, out)
  console.log(`✓ 安装引导 zip：${out}`)
  didInstaller = true
}

if (mode === "all" || mode === "portable") {
  const ext = process.platform === "win32" ? ".exe" : ""
  const exePath = join(TARGET_DIR, `${cargoBinName}${ext}`)
  if (!existsSync(exePath)) {
    const hint = `未找到主程序：${exePath}。先跑 \`pnpm package:exe\` 或 \`pnpm tauri build --no-bundle\``
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
    const readme = `# ${PRODUCT} ${VERSION} (Portable)\n\n解压后双击 ${PRODUCT}${ext} 即可运行，无需安装。仍需安装并配置官方 Claude CLI。\nClaudinal 应用配置与缓存保存在程序同级的 .claudinal/ 目录；移动程序时请一并保留该目录。\nClaude CLI 配置由 CLI 管理；会话 JSONL 及 Claudinal sidecar 仍在用户目录的 .claude/projects/ 中，移动程序不会搬移这些会话。\n此压缩包只含程序和说明，不包含个人配置、会话、测试或日志。\n`
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
