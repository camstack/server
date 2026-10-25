import {
  type JSX,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  createContext,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
  useCallback,
  useContext,
  useState,
} from 'react'
import { cn } from '../lib/cn'
import { TabsListScrollShell } from './tabs-list-scroll'

export type TabsAppearance = 'underline' | 'pills'

interface TabsContextValue {
  value: string
  setValue: (value: string) => void
  appearance: TabsAppearance
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabsContext() {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('Tabs compound components must be used within <Tabs>')
  return ctx
}

/* ── Root ── */

interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  value?: string
  onValueChange?: (value: string) => void
  defaultValue?: string
  /**
   * `underline` — border-b active (default, dialog editors).
   * `pills` — chip active fill; scrollbar sits under chips so it cannot
   * cover a bottom underline (Rules area strip).
   */
  appearance?: TabsAppearance
}

export function Tabs({
  value: controlledValue,
  onValueChange,
  defaultValue = '',
  appearance = 'underline',
  className,
  ...props
}: TabsProps): JSX.Element | null {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
  const value = controlledValue ?? uncontrolledValue

  const setValue = useCallback(
    (next: string) => {
      onValueChange?.(next)
      if (controlledValue === undefined) setUncontrolledValue(next)
    },
    [controlledValue, onValueChange],
  )

  return (
    <TabsContext.Provider value={{ value, setValue, appearance }}>
      <div className={className} {...props} />
    </TabsContext.Provider>
  )
}

/* ── TabsList ── */

/**
 * The strip SCROLLS sideways; it never squashes and never clips.
 *
 * Before this, the bar was a bare `flex flex-row`: every trigger was a
 * shrinkable flex item with no `whitespace-nowrap`, so past ~4 tabs on a narrow
 * viewport the labels wrapped inside a fixed-height (`h-7`) button and the
 * last tabs left the box with no way to reach them. That is the "the headers
 * are not scrollable" report on the Notification Center, whose rule sections
 * (6) and rule-editor tabs (up to 6) both live in one of these.
 *
 * BOTH axes are spelled out on purpose. Per CSS Overflow, `visible` is not
 * combinable with `auto`, so `overflow-x-auto` alone would silently promote
 * `overflow-y` to `auto` as well — and a one-row bar whose content box is
 * shortened by the horizontal scrollbar then raises a SECOND, vertical
 * scrollbar. That exact defect is documented on `SchemaTabBar`; `overflow-y`
 * pinned to `hidden` makes it impossible here.
 */
export function TabsList({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element | null {
  const { appearance, value } = useTabsContext()
  const listClassName = cn(
    'flex flex-row overflow-x-auto overflow-y-hidden',
    appearance === 'pills'
      ? 'gap-1 border-b border-border-subtle py-1'
      : 'border-b border-border-subtle',
    className,
  )
  return <TabsListScrollShell activeTabKey={value} listClassName={listClassName} {...props} />
}

/* ── TabsTrigger ── */

interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
}

export const TabsTrigger: ForwardRefExoticComponent<
  TabsTriggerProps & RefAttributes<HTMLButtonElement>
> = forwardRef<HTMLButtonElement, TabsTriggerProps>(function TabsTrigger(
  { value, className, ...props },
  ref,
): JSX.Element | null {
  const { value: activeValue, setValue, appearance } = useTabsContext()
  const isActive = value === activeValue
  const panelId = `tabpanel-${value}`

  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-controls={panelId}
      tabIndex={isActive ? 0 : -1}
      className={cn(
        // `inline-flex items-center gap-1.5`: icon + label sit on ONE row
        // (Identity Tokens & sessions). Without it, an SVG child stacks above
        // the label inside the fixed h-7 pill.
        // `shrink-0` + `whitespace-nowrap`: a trigger keeps its own width and
        // its label stays on one line, so the strip overflows (and scrolls)
        // instead of compressing every tab into an unreadable stack.
        'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap text-xs px-3 transition-colors',
        appearance === 'pills'
          ? isActive
            ? 'rounded-md bg-primary/10 font-medium text-primary'
            : 'rounded-md text-foreground-muted hover:bg-surface-hover hover:text-foreground'
          : isActive
            ? 'border-b-2 border-primary text-foreground font-medium'
            : 'text-foreground-muted hover:text-foreground',
        className,
      )}
      onClick={() => setValue(value)}
      {...props}
    />
  )
})

/* ── TabsContent ── */

interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string
}

export function TabsContent({ value, className, ...props }: TabsContentProps): JSX.Element | null {
  const { value: activeValue } = useTabsContext()
  if (value !== activeValue) return null

  return (
    <div role="tabpanel" id={`tabpanel-${value}`} className={cn('pt-3', className)} {...props} />
  )
}
