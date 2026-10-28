import {
  type JSX,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { type LucideIcon } from 'lucide-react'
import { cn } from '../lib/cn'

interface DropdownContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  triggerId: string
  contentId: string
  /** Live ref to the trigger element so the portal-rendered content can anchor to it. */
  triggerRef: React.RefObject<HTMLButtonElement | null>
}

const DropdownContext = createContext<DropdownContextValue | null>(null)

function useDropdownContext() {
  const ctx = useContext(DropdownContext)
  if (!ctx) throw new Error('Dropdown compound components must be used within <Dropdown>')
  return ctx
}

/* ── Root ── */

export interface DropdownProps {
  readonly children: ReactNode
  /**
   * Controlled open state. Give both `open` and `onOpenChange` to drive the menu
   * from outside (a "{" typed in a field opens the variable list); give neither
   * and the dropdown keeps its own state.
   */
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
}

export function Dropdown({
  children,
  open: controlledOpen,
  onOpenChange,
}: DropdownProps): JSX.Element | null {
  const [innerOpen, setInnerOpen] = useState(false)
  const controlled = controlledOpen !== undefined && onOpenChange !== undefined
  const open = controlled ? controlledOpen : innerOpen
  const setOpen = useCallback(
    (next: boolean): void => {
      if (controlled) onOpenChange(next)
      else setInnerOpen(next)
    },
    [controlled, onOpenChange],
  )
  const triggerId = useId()
  const contentId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  return (
    <DropdownContext.Provider value={{ open, setOpen, triggerId, contentId, triggerRef }}>
      <div className="relative inline-block">{children}</div>
    </DropdownContext.Provider>
  )
}

/* ── Trigger ── */

export function DropdownTrigger({
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element | null {
  const { open, setOpen, triggerId, contentId, triggerRef } = useDropdownContext()
  return (
    <button
      type="button"
      ref={triggerRef}
      id={triggerId}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? contentId : undefined}
      onClick={() => setOpen(!open)}
      {...props}
    >
      {children}
    </button>
  )
}

/* ── Content ── */

interface DropdownContentProps extends HTMLAttributes<HTMLDivElement> {
  /** Horizontal alignment relative to the trigger. Default: 'start' (left-aligned). */
  align?: 'start' | 'end'
  /** Pixel offset between trigger and content. Default: 4. */
  offset?: number
}

export function DropdownContent({
  className,
  children,
  align = 'start',
  offset = 4,
  ...props
}: DropdownContentProps): JSX.Element | null {
  const { open, setOpen, contentId, triggerId, triggerRef } = useDropdownContext()
  const ref = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{
    top: number
    left: number
    minWidth: number
  } | null>(null)

  // Compute absolute position from the trigger's bounding rect so the menu
  // renders in a portal (document.body) and escapes any ancestor overflow/clip.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    const compute = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const left = align === 'end' ? rect.right : rect.left
      setCoords({
        top: rect.bottom + offset,
        left,
        minWidth: rect.width,
      })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [open, align, offset, triggerRef])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const el = ref.current
      const trigger = triggerRef.current
      if (el && !el.contains(e.target as Node) && !trigger?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', escHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', escHandler)
    }
  }, [open, setOpen, triggerRef])

  if (!open || !coords || typeof document === 'undefined') return null

  const style: React.CSSProperties = {
    position: 'fixed',
    top: coords.top,
    ...(align === 'end' ? { right: window.innerWidth - coords.left } : { left: coords.left }),
    minWidth: coords.minWidth,
  }

  return createPortal(
    <div
      ref={ref}
      id={contentId}
      role="menu"
      aria-labelledby={triggerId}
      style={style}
      className={cn(
        'z-50 bg-background-elevated border border-border rounded-md shadow-lg py-1 min-w-[160px]',
        className,
      )}
      {...props}
    >
      {children}
    </div>,
    document.body,
  )
}

/* ── Item ── */

interface DropdownItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: LucideIcon
  variant?: 'default' | 'danger'
}

export function DropdownItem({
  className,
  icon: Icon,
  variant = 'default',
  children,
  onClick,
  ...props
}: DropdownItemProps): JSX.Element | null {
  const { setOpen } = useDropdownContext()

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e)
      setOpen(false)
    },
    [onClick, setOpen],
  )

  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        'h-7 text-xs px-2 w-full text-left flex items-center gap-2',
        variant === 'danger'
          ? 'text-danger hover:bg-danger/10'
          : 'text-foreground hover:bg-surface-hover',
        className,
      )}
      onClick={handleClick}
      {...props}
    >
      {Icon && <Icon size={14} />}
      {children}
    </button>
  )
}
