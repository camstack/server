import type { ReactNode } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@camstack/ui-library'
import { Settings, Sliders } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

/** PopoverContent — the floating elevated surface, rendered open. */
export const Open = () => (
  <Frame>
    <div className="pb-56">
      <Popover open>
        <PopoverTrigger className="inline-flex items-center gap-2 rounded-md border border-border bg-background-elevated px-3 py-1.5 text-sm font-medium text-foreground">
          <Settings className="h-4 w-4" />
          Backyard
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sliders className="h-4 w-4" />
            Stream profile
          </div>
          <div className="flex flex-col gap-1.5 text-sm text-foreground">
            <div className="flex items-center justify-between">
              <span className="text-foreground-subtle">Resolution</span>
              <span>1920×1080</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-foreground-subtle">Codec</span>
              <span>H.265</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-foreground-subtle">Provider</span>
              <span>ONVIF</span>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  </Frame>
)

/** Content with a richer footer (actions). */
export const WithActions = () => (
  <Frame>
    <div className="pb-56">
      <Popover open>
        <PopoverTrigger className="rounded-md border border-border bg-background-elevated px-3 py-1.5 text-sm font-medium text-foreground">
          Zone settings
        </PopoverTrigger>
        <PopoverContent className="w-64">
          <p className="mb-3 text-sm text-foreground">
            Apply motion zone <span className="font-medium">Driveway</span> to person detection
            only?
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1 text-xs text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
            >
              Apply
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  </Frame>
)
