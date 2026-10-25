import type { ReactNode } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@camstack/ui-library'
import { Camera, Info } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

/** TooltipTrigger wrapping an icon control, with its tooltip forced visible. */
export const InContext = () => (
  <Frame>
    <div className="flex justify-center pt-10">
      <Tooltip>
        <TooltipTrigger>
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background-elevated text-foreground">
            <Camera className="h-4 w-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="opacity-100">Take snapshot</TooltipContent>
      </Tooltip>
    </div>
  </Frame>
)

/** Trigger wrapping inline text + info glyph. */
export const TextTrigger = () => (
  <Frame>
    <div className="flex justify-center pt-10">
      <Tooltip>
        <TooltipTrigger>
          <span className="inline-flex items-center gap-1 text-sm text-foreground underline decoration-dotted">
            Bitrate
            <Info className="h-3.5 w-3.5 text-foreground-subtle" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="opacity-100">Average over last 60s</TooltipContent>
      </Tooltip>
    </div>
  </Frame>
)
