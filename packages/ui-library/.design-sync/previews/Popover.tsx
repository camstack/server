import type { ReactNode } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@camstack/ui-library'
import { Settings, Video, Bell, Moon } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

/** Hero: camera quick-settings popover, rendered open. */
export const Hero = () => (
  <Frame>
    <div className="pb-56">
      <Popover open>
        <PopoverTrigger className="inline-flex items-center gap-2 rounded-md border border-border bg-background-elevated px-3 py-1.5 text-sm font-medium text-foreground hover:bg-background-subtle">
          <Settings className="h-4 w-4" />
          Front Door
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">Quick settings</span>
            <span className="text-xs text-foreground-subtle">Hikvision</span>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center justify-between gap-3 text-sm text-foreground">
              <span className="flex items-center gap-2">
                <Video className="h-4 w-4 text-foreground-subtle" />
                Recording
              </span>
              <span className="rounded-full bg-success/20 px-2 py-0.5 text-xs text-success">
                On
              </span>
            </label>
            <label className="flex items-center justify-between gap-3 text-sm text-foreground">
              <span className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-foreground-subtle" />
                Notifications
              </span>
              <span className="rounded-full bg-background-subtle px-2 py-0.5 text-xs text-foreground-subtle">
                Off
              </span>
            </label>
            <label className="flex items-center justify-between gap-3 text-sm text-foreground">
              <span className="flex items-center gap-2">
                <Moon className="h-4 w-4 text-foreground-subtle" />
                Night vision
              </span>
              <span className="rounded-full bg-success/20 px-2 py-0.5 text-xs text-success">
                Auto
              </span>
            </label>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  </Frame>
)

/** Closed state — trigger only, popover collapsed. */
export const Closed = () => (
  <Frame>
    <Popover open={false}>
      <PopoverTrigger className="inline-flex items-center gap-2 rounded-md border border-border bg-background-elevated px-3 py-1.5 text-sm font-medium text-foreground">
        <Settings className="h-4 w-4" />
        Backyard
      </PopoverTrigger>
      <PopoverContent>hidden</PopoverContent>
    </Popover>
  </Frame>
)

/** Simple open popover with a short action list. */
export const ActionList = () => (
  <Frame>
    <div className="pb-44">
      <Popover open>
        <PopoverTrigger className="rounded-md border border-border bg-background-elevated px-3 py-1.5 text-sm font-medium text-foreground">
          Garage actions
        </PopoverTrigger>
        <PopoverContent className="w-56">
          <ul className="flex flex-col text-sm text-foreground">
            <li className="rounded px-2 py-1.5 hover:bg-background-subtle">Take snapshot</li>
            <li className="rounded px-2 py-1.5 hover:bg-background-subtle">Restart stream</li>
            <li className="rounded px-2 py-1.5 hover:bg-background-subtle">View timeline</li>
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  </Frame>
)
