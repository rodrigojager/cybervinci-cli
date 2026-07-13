import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  CYBERVINCI_CHANNEL: process.env["CYBERVINCI_CHANNEL"],
  CYBERVINCI_BUMP: process.env["CYBERVINCI_BUMP"],
  CYBERVINCI_VERSION: process.env["CYBERVINCI_VERSION"],
  CYBERVINCI_RELEASE: process.env["CYBERVINCI_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.CYBERVINCI_CHANNEL) return env.CYBERVINCI_CHANNEL
  if (env.CYBERVINCI_BUMP) return "latest"
  if (env.CYBERVINCI_VERSION && !env.CYBERVINCI_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.CYBERVINCI_VERSION) return env.CYBERVINCI_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const version = rootPkg.version
  if (typeof version !== "string" || !semver.valid(version)) {
    throw new Error("A valid root package.json version is required for latest-channel builds")
  }
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.CYBERVINCI_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

const bot = ["github-actions[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.CYBERVINCI_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`cybervinci script`, JSON.stringify(Script, null, 2))
