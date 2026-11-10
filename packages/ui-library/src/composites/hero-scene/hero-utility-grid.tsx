import type { LucideIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../primitives/tooltip'
import { heroUtilityLayout } from './hero-utility-layout'

/** One utility of a device: a button with an icon, a label and its current state. */
export interface HeroUtility {
  readonly id: string
  readonly icon: LucideIcon
  readonly label: string
  /** The compact current state ("On", "1 low"); absent when there is none to show. */
  readonly value?: string
  /** `warning` colours the value when the state wants attention. */
  readonly tone?: 'default' | 'warning'
  /** What the button opens or does, in one sentence. */
  readonly tooltip: string
  /** A plain button: runs on press. */
  readonly onPress?: () => void
  /** A button that opens a small panel; `close` dismisses it. Wins over `onPress`. */
  readonly panel?: (close: () => void) => ReactNode
  /** Neither `onPress` nor `panel` and no hover state: shows the state only. */
  readonly disabled?: boolean
}

export interface HeroUtilityGridProps {
  readonly items: readonly HeroUtility[]
  readonly className?: string
}

const FACE =
  'flex w-full min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-2 text-left text-[13px] text-foreground'
const INTERACTIVE =
  'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

function Face({ item }: { readonly item: HeroUtility }): ReactNode {
  const Icon = item.icon
  return (
    <>
      <Icon className="size-4 shrink-0 text-foreground-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
      {item.value === undefined ? null : (
        <span
          className={cn(
            'shrink-0 text-xs tabular-nums',
            item.tone === 'warning' ? 'text-warning' : 'text-foreground-muted',
          )}
        >
          {item.value}
        </span>
      )}
    </>
  )
}

function PanelButton({
  item,
  panel,
}: {
  readonly item: HeroUtility
  readonly panel: (close: () => void) => ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen} className="block w-full">
      <PopoverTrigger className={cn(FACE, INTERACTIVE)} data-testid={`hero-utility-${item.id}`}>
        <Face item={item} />
      </PopoverTrigger>
      <PopoverContent>{panel(() => setOpen(false))}</PopoverContent>
    </Popover>
  )
}

function UtilityButton({ item }: { readonly item: HeroUtility }): ReactNode {
  if (item.panel !== undefined && item.disabled !== true) {
    return <PanelButton item={item} panel={item.panel} />
  }
  if (item.onPress !== undefined && item.disabled !== true) {
    return (
      <Button
        variant="outline"
        className={cn(FACE, 'h-auto justify-start font-normal')}
        data-testid={`hero-utility-${item.id}`}
        onClick={item.onPress}
      >
        <Face item={item} />
      </Button>
    )
  }
  return (
    <div
      role="group"
      aria-label={item.label}
      tabIndex={0}
      className={cn(FACE, 'cursor-default')}
      data-testid={`hero-utility-${item.id}`}
      data-readonly="true"
    >
      <Face item={item} />
    </div>
  )
}

/**
 * The utility section of the hero card: one button per utility the device has,
 * on a two-column grid (`heroUtilityLayout`), each with its own tooltip. No
 * utility, no section.
 */
export function HeroUtilityGrid({ items, className }: HeroUtilityGridProps): ReactNode {
  const spans = heroUtilityLayout(items.length)
  if (items.length === 0) return null
  return (
    <div data-testid="hero-utility-grid" className={cn('grid grid-cols-2 gap-2', className)}>
      {items.map((item, i) => (
        <div key={item.id} className={cn('min-w-0', spans[i] === 2 && 'col-span-2')}>
          <Tooltip className="block w-full min-w-0">
            <TooltipTrigger className="w-full">
              <UtilityButton item={item} />
            </TooltipTrigger>
            <TooltipContent className="w-52 whitespace-normal text-center">
              {item.tooltip}
            </TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  )
}
