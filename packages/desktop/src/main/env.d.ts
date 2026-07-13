interface ImportMetaEnv {
  readonly CYBERVINCI_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:cybervinci-server" {
  export namespace Server {
    export const listen: typeof import("../../../cybervinci/dist/types/src/node").Server.listen
    export type Listener = import("../../../cybervinci/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../cybervinci/dist/types/src/node").Config.get
    export type Info = import("../../../cybervinci/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../cybervinci/dist/types/src/node").bootstrap
}
