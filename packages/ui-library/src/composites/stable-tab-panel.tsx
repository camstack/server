/**
 * StableTabPanel — keeps scroll position when the tab inside it changes.
 *
 * Holding outgoing height avoids the browser clamping scrollTop when a tall
 * panel is replaced by a short loading stub. See the admin-ui history of this
 * file for the full failure mode (phone forms, cold-mounted queries).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type JSX } from 'react'

const MAX_HOLD_MS = 1_500

export interface StableTabPanelProps {
  /** Changes when the visible panel changes — must identify the tab. */
  readonly tabKey: string
  readonly children: ReactNode
  readonly className?: string
  /** Stretch into a fill parent so section bodies can host a flex DataTable. */
  readonly fill?: boolean
}

export function StableTabPanel({
  tabKey,
  children,
  className,
  fill = false,
}: StableTabPanelProps): JSX.Element {
  const innerRef = useRef<HTMLDivElement | null>(null)
  const lastHeightRef = useRef(0)
  const [heldPx, setHeldPx] = useState<number | null>(null)
  const previousKeyRef = useRef(tabKey)

  const sample = (): void => {
    const height = innerRef.current?.offsetHeight ?? 0
    if (height > 0) lastHeightRef.current = height
    setHeldPx((held) => (held !== null && height >= held ? null : held))
  }

  useLayoutEffect(() => {
    if (previousKeyRef.current === tabKey) return
    previousKeyRef.current = tabKey
    const outgoing = lastHeightRef.current
    if (outgoing > 0) setHeldPx(outgoing)
  }, [tabKey])

  useEffect(sample)

  useEffect(() => {
    const inner = innerRef.current
    if (!inner || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sample)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (heldPx === null) return
    const timer = setTimeout(() => setHeldPx(null), MAX_HOLD_MS)
    return () => clearTimeout(timer)
  }, [heldPx])

  return (
    <div
      className={fill ? `flex min-h-0 flex-1 flex-col ${className ?? ''}` : className}
      style={heldPx === null ? undefined : { minHeight: heldPx }}
    >
      <div ref={innerRef} className={fill ? 'flex h-full min-h-0 flex-1 flex-col' : undefined}>
        {children}
      </div>
    </div>
  )
}
