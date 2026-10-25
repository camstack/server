import type { ReactNode } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@camstack/ui-library'
import { Volume2, Wifi } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

/** TooltipContent — the floating label bubble, forced visible above the trigger. */
export const Visible = () => (
  <Frame>
    <div className="flex justify-center pt-10">
      <Tooltip>
        <TooltipTrigger>
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background-elevated text-foreground">
            <Volume2 className="h-4 w-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="opacity-100">Mute stream audio</TooltipContent>
      </Tooltip>
    </div>
  </Frame>
)

/** Longer descriptive label content. */
export const LongLabel = () => (
  <Frame>
    <div className="flex justify-center pt-10">
      <Tooltip>
        <TooltipTrigger>
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background-elevated text-foreground">
            <Wifi className="h-4 w-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="opacity-100">
          Connection: ONVIF · restreamer · 1080p
        </TooltipContent>
      </Tooltip>
    </div>
  </Frame>
)
