const result = Bun.spawnSync(["git", "diff", "--name-only", "--diff-filter=U"], {
  stdout: "pipe",
  stderr: "inherit",
})

if (result.exitCode !== 0) process.exit(result.exitCode)

const paths = result.stdout
  .toString()
  .split(/\r?\n/)
  .filter(Boolean)

function resolve(content: string, side: "ours" | "theirs") {
  const output: string[] = []
  let state: "normal" | "ours" | "base" | "theirs" = "normal"
  let conflicts = 0

  for (const line of content.match(/.*(?:\r\n|\n|$)/g) ?? []) {
    if (!line) continue
    if (line.startsWith("<<<<<<< ")) {
      if (state !== "normal") throw new Error("Nested conflict marker is not supported")
      state = "ours"
      conflicts++
      continue
    }
    if (line.startsWith("||||||| ")) {
      if (state !== "ours") throw new Error("Unexpected base conflict marker")
      state = "base"
      continue
    }
    if (line.startsWith("=======")) {
      if (state !== "ours" && state !== "base") throw new Error("Unexpected conflict separator")
      state = "theirs"
      continue
    }
    if (line.startsWith(">>>>>>> ")) {
      if (state !== "theirs") throw new Error("Unexpected conflict end marker")
      state = "normal"
      continue
    }
    if (state === "normal" || state === side) output.push(line)
  }

  if (state !== "normal") throw new Error("Unterminated conflict marker")
  return { content: output.join(""), conflicts }
}

let resolved = 0
let hunks = 0

for (const path of paths) {
  const file = Bun.file(path)
  if (!(await file.exists())) continue
  const content = await file.text()
  if (!content.includes("<<<<<<< ")) continue

  // The service documentation was deliberately rewritten as compatibility
  // documentation for the fork. Keep those local hunks while accepting the
  // incoming implementation and test hunks everywhere else.
  const side = path.startsWith("packages/web/src/content/docs/") ? "ours" : "theirs"
  const next = resolve(content, side)
  await Bun.write(path, next.content)
  resolved++
  hunks += next.conflicts
}

console.log(`Resolved ${hunks} conflict hunks in ${resolved} files`)
