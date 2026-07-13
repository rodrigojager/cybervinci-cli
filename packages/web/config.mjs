const stage = process.env.SST_STAGE || "dev"
const local = "http://localhost:4321"

export default {
  url: process.env.CYBERVINCI_SITE_URL || local,
  console: process.env.CYBERVINCI_CONSOLE_URL || "https://opencode.ai/auth",
  email: process.env.CYBERVINCI_SUPPORT_EMAIL || "",
  socialCard: process.env.CYBERVINCI_SOCIAL_CARD_URL || "",
  github: process.env.CYBERVINCI_SOURCE_URL || "",
  discord: process.env.CYBERVINCI_COMMUNITY_URL || "",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
  stage,
}
