import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.CYBERVINCI_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// CyberVinci must never consume OpenCode's release feed. Enable this only after
// an operator-controlled CYBERVINCI feed is explicitly configured in electron-builder.
export const UPDATER_ENABLED = false
