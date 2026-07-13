import { Icon as IconV2 } from "@cybervinci-ai/ui/v2/icon"
import { IconButtonV2 } from "@cybervinci-ai/ui/v2/icon-button-v2"
import { createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Drawer, DrawerClose, DrawerContent } from "@/components/ui/drawer"

import introducingTabsVideo from "@/assets/help/introducing-tabs.mp4"
import { Persist, persisted } from "@/utils/persist"

export function HelpButton() {
  return null
}
// can remove this after the tabs rollout has been out for a while
export function TabsInfoPopup() {
  if (import.meta.env.VITE_CYBERVINCI_CHANNEL !== "dev") return null

  const [state, setState] = persisted(Persist.global("tabsInfoPopup"), createStore({ dismissed: false }))
  // setState({ dismissed: false }) // for testing
  const [drawerOpen, setDrawerOpen] = createSignal(false)

  return (
    <Drawer open={drawerOpen()} onOpenChange={setDrawerOpen} side="right">
      <Show when={!state.dismissed}>
        <div
          class="fixed bottom-14 right-5 z-50 h-[240px] w-[192px] rounded-[8px] bg-v2-background-bg-base p-1 shadow-[var(--v2-elevation-floating)]"
          aria-label="Introducing Tabs. A faster, more intuitive way to work."
        >
          <button
            type="button"
            aria-label="Dismiss Tabs information"
            class="absolute top-3 right-3 z-10 size-5 flex items-center justify-center rounded-[4px] bg-[rgba(0,0,0,0.4)]"
            onClick={() => setState("dismissed", true)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path d="M4.25 11.75L11.75 4.25M11.75 11.75L4.25 4.25" stroke="white" />
            </svg>
          </button>
          <button
            type="button"
            class="relative block h-[232px] w-[184px] cursor-pointer overflow-hidden rounded-[4px] text-left"
            onClick={() => {
              setState("dismissed", true)
              setDrawerOpen(true)
            }}
          >
            <video
              src={introducingTabsVideo}
              class="absolute inset-0 h-full w-full object-cover"
              loop
              muted
              autoplay
              playsinline
              aria-hidden="true"
              onContextMenu={(event) => event.preventDefault()}
            />
            <div class="absolute inset-x-0 bottom-0 flex w-full flex-col items-start gap-1.5 bg-[linear-gradient(180deg,rgba(0,0,0,0)_0%,#000000_100%)] px-3 py-5">
              <p class="w-full select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-[#FFFFFF]">
                Introducing Tabs
              </p>
              <p class="w-full select-none text-[13px] font-[440] leading-[140%] tracking-[-0.04px] text-[#808080]">
                A faster, more intuitive way to work.
              </p>
            </div>
          </button>
        </div>
      </Show>
      <DrawerContent>
        <div class="flex h-[52px] w-full shrink-0 items-center gap-4 self-stretch border-b border-v2-border-border-muted p-4">
          <p class="min-h-0 min-w-0 flex-1 text-[13px] font-[530] leading-5 tracking-[-0.04px] tabular-nums text-v2-text-text-muted">
            June 16
          </p>
          <DrawerClose
            as={IconButtonV2}
            type="button"
            size="small"
            variant="ghost-muted"
            aria-label="Close"
            icon={<IconV2 name="xmark-small" />}
          />
        </div>
        <div class="relative flex w-full flex-col items-start gap-6 p-8">
          <p class="w-full shrink-0 self-stretch text-[21px] font-[610] leading-6 tracking-[-0.37px] tabular-nums text-v2-text-text-base">
            Introducing Tabs Navigation.
          </p>
          <p class="w-full flex-1 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base">
            We've introduced tabs as the primary navigation in CYBERVINCI. Your most important session are now pinned at
            the top of your screen at all times. No more hunting through menus or losing your place mid-session. Switch
            contexts instantly, pick up exactly where you left off, and keep your focus where it belongs: on the
            sessions.
          </p>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
