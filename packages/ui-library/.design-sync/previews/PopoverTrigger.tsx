import type { ReactNode } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@camstack/ui-library'
import { Settings, ChevronDown } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

/** PopoverTrigger in place — the clickable button that opens the popover. */
export const InContext = () => (
  <Frame>
    <div className="pb-44">
      <Popover open>
        <PopoverTrigger className="inline-flex items-center gap-2 rounded-md border border-border bg-background-elevated px-3 py-1.5 text-sm font-medium text-foreground hover:bg-background-subtle">
          <Settings className="h-4 w-4" />
          Driveway
          <ChevronDown className="h-4 w-4 text-foreground-subtle" />
        </PopoverTrigger>
        <PopoverContent className="w-60">
          <p className="text-sm text-foreground">
            Stream profile, recording and zones for this camera.
          </p>
        </PopoverContent>
      </Popover>
    </div>
  </Frame>
)

/** Trigger collapsed (popover closed) — shows the default resting state. */
export const Resting = () => (
  <Frame>
    <Popover open={false}>
      <PopoverTrigger className="inline-flex items-center gap-2 rounded-md border border-border bg-background-elevated px-3 py-1.5 text-sm font-medium text-foreground">
        <Settings className="h-4 w-4" />
        Living Room
        <ChevronDown className="h-4 w-4 text-foreground-subtle" />
      </PopoverTrigger>
      <PopoverContent>hidden</PopoverContent>
    </Popover>
  </Frame>
)
