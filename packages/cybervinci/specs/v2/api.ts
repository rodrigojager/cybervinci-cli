// @ts-nocheck

import { CYBERVINCI } from "@cybervinci-ai/core"
import { ReadTool } from "@cybervinci-ai/core/tools"

const cybervinci = CYBERVINCI.make({})

cybervinci.tool.add(ReadTool)

cybervinci.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

cybervinci.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

cybervinci.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await cybervinci.session.create({
  agent: "build",
})

cybervinci.subscribe((event) => {
  console.log(event)
})

await cybervinci.session.prompt({
  sessionID,
  text: "hey what is up",
})

await cybervinci.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await cybervinci.session.wait()

console.log(await cybervinci.session.messages(sessionID))
