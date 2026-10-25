import {
  type JSX,
  type HTMLAttributes,
  type ReactNode,
  createContext,
  useContext,
  useId,
  useRef,
  useState,
} from 'react'
import { cn } from '../lib/cn'

interface TooltipContextValue {
  open: boolean
  show: () => void
  hide: () => void
  tooltipId: string
}

const TooltipContext = createContext<TooltipContextValue | null>(null)

function useTooltipContext() {
  const ctx = useContext(TooltipContext)
  if (!ctx) throw new Error('Tooltip compound components must be used within <Tooltip>')
  return ctx
}

/* ── Root ── */

interface TooltipProps {
  readonly children: ReactNode
  /** Extra classes for the positioning wrapper. Defaults to `inline-block`
   *  (shrink-to-fit). Pass `block w-full min-w-0` when the trigger must fill a
   *  width-constrained parent so its inner content can truncate cleanly. */
  readonly className?: string
  /** Holds the tooltip open (or shut) regardless of hover — an error the
   *  control has to show until it is dismissed. Hover drives it when absent. */
  readonly open?: boolean
}

export function Tooltip({ children, className, open: forcedOpen }: TooltipProps): JSX.Element {
  const [hoverOpen, setOpen] = useState(false)
  const open = forcedOpen ?? hoverOpen
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const tooltipId = useId()

  const show = () => {
    timerRef.current = setTimeout(() => setOpen(true), 300)
  }

  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setOpen(false)
  }

  return (
    <TooltipContext.Provider value={{ open, show, hide, tooltipId }}>
      <div className={cn('relative', className ?? 'inline-block')}>{children}</div>
    </TooltipContext.Provider>
  )
}

/* ── Trigger ── */

export function TooltipTrigger({
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  const { show, hide, tooltipId, open } = useTooltipContext()

  return (
    <div
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={open ? tooltipId : undefined}
      {...props}
    >
      {children}
    </div>
  )
}

/* ── Content ── */

export function TooltipContent({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  const { open, tooltipId } = useTooltipContext()

  return (
    <div
      id={tooltipId}
      role="tooltip"
      className={cn(
        'absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-foreground text-background text-xs px-2 py-1 rounded-md shadow-md whitespace-nowrap pointer-events-none transition-opacity duration-150',
        open ? 'opacity-100' : 'opacity-0',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}
