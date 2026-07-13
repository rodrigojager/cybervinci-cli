import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.CYBERVINCI_CHANNEL ?? "dev"}`

await $`cd ../cybervinci && bun script/build-node.ts`
