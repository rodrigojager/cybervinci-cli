import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Fiber, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { CrossSpawnSpawner } from "../../src/cross-spawn-spawner"

await Effect.gen(function* () {
  const spawner = yield* CrossSpawnSpawner.make
  const started = Date.now()
  const handle = yield* spawner.spawn(
    ChildProcess.make(process.execPath, [
      "-e",
      'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setTimeout(()=>{},6000)"],{stdio:["ignore","inherit","inherit"]}); child.unref(); console.log("retained output"); process.exit(0)',
    ]),
  )
  const collector = yield* Stream.runCollect(handle.stdout).pipe(Effect.forkScoped)
  const exit = yield* handle.exitCode
  console.log(JSON.stringify({ event: "exit", exit, elapsed: Date.now() - started, running: yield* handle.isRunning }))
  const output = yield* Fiber.join(collector)
  console.log(
    JSON.stringify({ event: "output", elapsed: Date.now() - started, bytes: output.reduce((n, x) => n + x.length, 0) }),
  )
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)), Effect.runPromise)
