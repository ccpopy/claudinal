import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [assetsDir, repository, tag, version] = process.argv.slice(2)

if (!assetsDir || !repository || !tag || !version) {
  throw new Error(
    "Usage: node scripts/generate-latest-json.mjs <assetsDir> <owner/repo> <tag> <version>"
  )
}

const files = readdirSync(assetsDir).filter((file) => !file.endsWith(".sig"))

const targets = [
  {
    platform: "windows-x86_64",
    match: (file) => file.endsWith("-setup-windows-x64.exe")
  },
  {
    platform: "darwin-x86_64",
    match: (file) => file.includes(".app-") && file.endsWith("-macos-x64.tar.gz")
  },
  {
    platform: "darwin-aarch64",
    match: (file) => file.includes(".app-") && file.endsWith("-macos-arm64.tar.gz")
  },
  {
    platform: "linux-x86_64",
    match: (file) => file.endsWith("-linux-x64.AppImage")
  }
]

function findArtifact(target) {
  const matches = files.filter(target.match)
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one updater artifact for ${target.platform}, found ${matches.length}: ${matches.join(", ")}`
    )
  }
  const artifact = matches[0]
  const sigPath = join(assetsDir, `${artifact}.sig`)
  let signature
  try {
    signature = readFileSync(sigPath, "utf8").trim()
  } catch (error) {
    throw new Error(`Missing updater signature for ${artifact}: ${error}`)
  }
  if (!signature) {
    throw new Error(`Empty updater signature for ${artifact}`)
  }
  return { artifact, signature }
}

const platforms = Object.fromEntries(
  targets.map((target) => {
    const { artifact, signature } = findArtifact(target)
    return [
      target.platform,
      {
        signature,
        url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifact)}`
      }
    ]
  })
)

const latest = {
  version,
  notes: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
  pub_date: new Date().toISOString(),
  platforms
}

writeFileSync(join(assetsDir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`)
