const internalPackages = [
  "effect-drizzle-sqlite",
  "effect-sqlite-node",
  "codex-account-pool",
  "httpapi-codegen",
  "github-action",
  "http-recorder",
  "session-ui",
  "stats-server",
  "stats-core",
  "stats-app",
  "sdk-next",
  "storybook",
  "enterprise",
  "codemode",
  "desktop",
  "function",
  "protocol",
  "schema",
  "server",
  "script",
  "client",
  "plugin",
  "slack",
  "core",
  "tui",
  "cli",
  "app",
  "web",
  "ui",
  "sdk",
  "llm",
  "ai",
]

const tracked = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard"], {
  stdout: "pipe",
  stderr: "inherit",
})
if (tracked.exitCode !== 0) process.exit(tracked.exitCode)

const packagePattern = new RegExp(
  `@opencode-ai/(${internalPackages.map((name) => name.replaceAll("-", "\\-")).join("|")})(?=$|[/\\s\"'\\\`,.:;)]|-(?:darwin|linux|windows))`,
  "g",
)

const paths = tracked.stdout
  .toString()
  .split(/\r?\n/)
  .filter(Boolean)

let files = 0
let replacements = 0

const compatibilityEnv = /^(OPENCODE_API_KEY|OPENCODE_CONSOLE_TOKEN|OPENCODE_RECORD_|OPENCODE_CODEX_)/
const productRoots = [
  "packages/app/",
  "packages/desktop/",
  "packages/cybervinci/",
  "packages/session-ui/",
  "packages/tui/",
  "packages/ui/",
  "installer/",
]

function brandProductLine(line: string) {
  const service = new Map([
    ["OpenCode Zen", "__CYBERVINCI_SERVICE_ZEN__"],
    ["OpenCode Go", "__CYBERVINCI_SERVICE_GO__"],
    ["OpenCode Console", "__CYBERVINCI_SERVICE_CONSOLE__"],
  ])
  if (/\bid\s*:\s*["']opencode["']/.test(line)) return line
  if (line.includes("@cybervinci-ai/client") || /\bOpenCode\./.test(line)) return line
  const protectedLine = [...service].reduce((value, [name, marker]) => value.replaceAll(name, marker), line)
  const branded = protectedLine
    .replace(/\bOpenCode\b/g, "CYBERVINCI")
    .replaceAll("OpenCoden", "CYBERVINCIn")
    .replaceAll("OpenCodessa", "CYBERVINCIssa")
    .replaceAll("OpenCodea", "CYBERVINCIa")
    .replaceAll("OpenCodes", "CYBERVINCIs")
    .replaceAll("'opencode'", "'cybervinci'")
    .replaceAll("`opencode`", "`cybervinci`")
  return [...service].reduce((value, [name, marker]) => value.replaceAll(marker, name), branded)
}

for (const path of paths) {
  if (path.endsWith("script/apply-cybervinci-brand.ts")) continue
  if (path.endsWith("bun.lock")) continue
  const file = Bun.file(path)
  if (!(await file.exists()) || file.size > 5_000_000) continue
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.includes(0)) continue
  const content = new TextDecoder().decode(bytes)
  const packageBranded = content
    .replace(packagePattern, (_match, name: string) => `@cybervinci-ai/${name}`)
    .replaceAll("@opencode/", "@cybervinci/")
    .replaceAll("packages/opencode", "packages/cybervinci")
    .replaceAll("packages\\opencode", "packages\\cybervinci")
  const internal = path.startsWith("packages/console/") || path.startsWith("packages/codex-account-pool/")
    ? packageBranded
    : packageBranded
        .replaceAll("VITE_OPENCODE_", "VITE_CYBERVINCI_")
        .replace(/\bOPENCODE_[A-Z0-9_]+\b/g, (name) =>
          compatibilityEnv.test(name) ? name : `CYBERVINCI_${name.slice("OPENCODE_".length)}`,
        )
        .replaceAll("opencode.global.dat", "cybervinci.global.dat")
        .replaceAll("opencode.window.", "cybervinci.window.")
        .replaceAll("opencode.jsonc", "cybervinci.jsonc")
        .replaceAll("opencode.json", "cybervinci.json")
        .replaceAll("C:/OpenCode", "C:/CyberVinci")
        .replaceAll("/opencode-demo", "/cybervinci-demo")
        .replaceAll("createOpencodeClient", "createCyberVinciClient")
        .replaceAll("OpencodeClient", "CyberVinciClient")
        .replaceAll("resolveWslOpencode", "resolveWslCyberVinci")
        .replaceAll("wsl.onboarding.step.opencode", "wsl.onboarding.step.cybervinci")
        .replaceAll("installOpencode", "installCyberVinci")
        .replaceAll("checkingOpencode", "checkingCyberVinci")
        .replaceAll("updatingOpencode", "updatingCyberVinci")
        .replaceAll("updateOpencode", "updateCyberVinci")
        .replaceAll("opencodeReady", "cybervinciReady")
        .replaceAll("opencodeMissing", "cybervinciMissing")
        .replaceAll("opencodeCannotRun", "cybervinciCannotRun")
        .replaceAll("opencodeNotInstalled", "cybervinciNotInstalled")
  const next = productRoots.some((root) => path.startsWith(root))
    ? internal
        .split(/(?<=\n)/)
        .map(brandProductLine)
        .join("")
    : internal

  if (next === content) continue
  replacements += content.split(packagePattern).length - 1
  await Bun.write(path, next)
  files++
}

console.log(`Applied CyberVinci package branding to ${files} files (${replacements} scoped references)`)
