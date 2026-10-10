import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const manifest = JSON.parse(read("package.json"))
const crates = read("src-tauri/Cargo.lock")
  .split(/^\[\[package\]\]\s*$/m)
  .map((block) => ({
    name: block.match(/^name = "([^"]+)"\r?$/m)?.[1],
    version: block.match(/^version = "([^"]+)"\r?$/m)?.[1]
  }))
const minorRelease = (version) => version.split(".").slice(0, 2).join(".")
const errors = []
let checked = 0

// Match Tauri CLI's packaging requirement using installed, locked versions.
// Patch releases can differ, and Rust-only plugins need no JavaScript pair.
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
  const crate = name === "@tauri-apps/api" ? "tauri"
    : name.startsWith("@tauri-apps/plugin-") ? name.replace("@tauri-apps/", "tauri-") : null
  if (!crate) continue
  const { version } = JSON.parse(read(`node_modules/${name}/package.json`))
  const rustVersions = crates.filter((entry) => entry.name === crate).map((entry) => entry.version)
  if (!rustVersions.some((rustVersion) => rustVersion && minorRelease(rustVersion) === minorRelease(version))) {
    errors.push(`${crate} (${rustVersions.join(", ") || "missing from Cargo.lock"}) : ${name} (${version})`)
  }
  checked += 1
}

if (errors.length) {
  console.error(`Tauri NPM packages and Rust crates must use the same major/minor release:\n${errors.join("\n")}`)
  process.exitCode = 1
} else {
  console.log(`Tauri version compatibility: ${checked} NPM/Rust pairs match.`)
}
