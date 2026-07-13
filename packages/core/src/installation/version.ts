declare global {
  const CYBERVINCI_VERSION: string
  const CYBERVINCI_CHANNEL: string
}

export const InstallationVersion = typeof CYBERVINCI_VERSION === "string" ? CYBERVINCI_VERSION : "local"
export const InstallationChannel = typeof CYBERVINCI_CHANNEL === "string" ? CYBERVINCI_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
