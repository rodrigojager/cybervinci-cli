export * from "./client.js"
export * from "./server.js"

import { createCyberVinciClient } from "./client.js"
import { createCyberVinciServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createCyberVinci(options?: ServerOptions) {
  const server = await createCyberVinciServer({
    ...options,
  })

  const client = createCyberVinciClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
