import type { ReactNode } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@camstack/ui-library'
import { Maximize2, Mic, Power } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const ControlButton = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background-elevated text-foreground">
    {children}
  </span>
)

/** Hero: tooltip on a camera control button, forced visible (opacity-100). */
export const Hero = () => (
  <Frame>
    <div className="flex justify-center pt-10">
      <Tooltip>
        <TooltipTrigger>
          <ControlButton>
            <Maximize2 className="h-4 w-4" />
          </ControlButton>
        </TooltipTrigger>
        <TooltipContent className="opacity-100">Fullscreen</TooltipContent>
      </Tooltip>
    </div>
  </Frame>
)

/** Resting tooltip (hidden) next to a forced-visible one — shows both states. */
export const States = () => (
  <Frame>
    <div className="flex items-center justify-center gap-8 pt-10">
      <Tooltip>
        <TooltipTrigger>
          <ControlButton>
            <Mic className="h-4 w-4" />
          </ControlButton>
        </TooltipTrigger>
        <TooltipContent className="opacity-100">Two-way audio</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger>
          <ControlButton>
            <Power className="h-4 w-4" />
          </ControlButton>
        </TooltipTrigger>
        <TooltipContent>Restart device</TooltipContent>
      </Tooltip>
    </div>
  </Frame>
)
