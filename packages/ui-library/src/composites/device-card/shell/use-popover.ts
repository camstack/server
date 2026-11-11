/** One open/closed popover that closes on an outside press and on Escape. */
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

export interface PopoverState {
  readonly open: boolean
  readonly toggle: () => void
  readonly close: () => void
  readonly rootRef: RefObject<HTMLDivElement | null>
}

export function usePopover(): PopoverState {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const close = useCallback(() => setOpen(false), [])
  const toggle = useCallback(() => setOpen((v) => !v), [])
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, toggle, close, rootRef }
}
