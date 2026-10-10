// Tauri NSIS filenames include the unchanged product name, version and target
// architecture. Shared Cargo targets may also contain other apps or old builds.
export function selectNsisInstaller(names, productName, version) {
  const expected = ["x64", "x86", "arm64"].map(
    (arch) => `${productName}_${version}_${arch}-setup.exe`
  )
  const candidates = names.filter((name) => expected.includes(name))
  if (candidates.length === 0) {
    throw new Error(`未找到当前版本安装包。预期文件：${expected.join("、")}`)
  }
  if (candidates.length !== 1) {
    throw new Error(`当前版本安装包不唯一，请明确构建架构：${candidates.join("、")}`)
  }
  return candidates[0]
}
