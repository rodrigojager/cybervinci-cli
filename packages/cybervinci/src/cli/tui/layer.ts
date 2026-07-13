import { run as runTui, type TuiInput } from "@cybervinci-ai/tui"
import { Global } from "@cybervinci-ai/core/global"
import { AppNodeBuilder } from "@cybervinci-ai/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
