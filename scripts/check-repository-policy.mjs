import { execFileSync } from "node:child_process"

// Documents, standalone tests and logs are local-only. Embedded source tests are allowed.
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)
const prohibited = paths.filter((path) =>
  /(^|\/)(doc|test|tests|__tests__|__fixtures__|__snapshots__|logs|coverage|test-results|playwright-report)\//i.test(path)
  || /\.(test|spec)\.[^/]+$/i.test(path)
  || /\.log(?:\.[^/]*)?$/i.test(path)
  || /(^|\/)claudinal-diagnostics[^/]*\.json$/i.test(path)
  || /(^|\/)test_[^/]*\.py$|_test\.rs$|\.snap$/i.test(path)
  || /^\.trellis\/workspace\//.test(path)
)
if (prohibited.length) {
  console.error(`Local-only files must be removed from Git tracking:\n${prohibited.join("\n")}`)
  process.exitCode = 1
} else {
  console.log("Repository policy: no tracked local documents, standalone tests or logs.")
}
