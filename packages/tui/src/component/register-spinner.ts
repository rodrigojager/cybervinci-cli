import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerCyberVinciSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
