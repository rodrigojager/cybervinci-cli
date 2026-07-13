import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@cybervinci-ai/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~cybervinci/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~cybervinci/WorkspaceRef", {
  defaultValue: () => undefined,
})
