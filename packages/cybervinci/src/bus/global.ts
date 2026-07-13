import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const event = eventName === "event" ? (args[0] as GlobalEvent | undefined) : undefined
    if (event?.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return Reflect.apply(EventEmitter.prototype.emit, this, [eventName, ...args]) as boolean
  }
}

export const GlobalBus = new GlobalBusEmitter()
