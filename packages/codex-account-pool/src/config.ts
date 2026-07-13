import { settingsSchema, defaultSettings, type Settings } from "./domain"
import { paths, readJson, transact } from "./storage"

export class SettingsStore {
  private cached?: { value: Settings; mtime: number }

  constructor(readonly path = paths.settings) {}
  async get(force = false) {
    if (!force && this.cached && Date.now() - this.cached.mtime < 1000) return this.cached.value
    const value = await readJson(this.path, settingsSchema, defaultSettings)
    this.cached = { value, mtime: Date.now() }
    return value
  }

  async save(next: Omit<Settings, "version" | "revision"> | Settings) {
    const value = await transact({
      key: `settings:${this.path}`,
      path: this.path,
      schema: settingsSchema,
      fallback: defaultSettings,
      update(current) {
        const parsed = settingsSchema.parse({ ...next, version: 1, revision: current.revision + 1 })
        Object.assign(current, parsed)
        return parsed
      },
    })
    this.cached = { value, mtime: Date.now() }
    return value
  }
}
