import { $ } from "bun"
import { downloadCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.CYBERVINCI_CHANNEL ?? "dev"}`

await $`cd ../cybervinci && bun script/build-node.ts`
await downloadCliToResources()
