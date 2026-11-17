/**
 * useDragValue — input smoothing for a slider that sends a device command.
 *
 * A control renders the slice the hub serves (D1061). A range input that sent a
 * command on every move and rendered the served value snapped back under the
 * hand: each poll or slice push between two moves pulled the thumb to an older
 * value. This hook keeps a LOCAL value only for as long as the hand is on the
 * thumb plus the trailing commit:
 *
 * - while the thumb moves, the thumb shows where the hand is and nothing is sent;
 * - on release (pointer up or cancel, key up, blur) ONE command is sent — a
 *   pointer let go OUTSIDE the input included: while the thumb moves, the
 *   window's pointerup / pointercancel commits too;
 * - the released value stays until the hub answers — the served value equals
 *   what was sent, or moves away from what it was at release (the device
 *   answered otherwise) — or until `settleMs` pass without an answer;
 * - from then on the served slice is shown again.
 *
 * It is not optimism: nothing here outlives the gesture, and a second client
 * never sees it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** How long a released value waits for the hub's answer before the served value is shown. */
export const DRAG_SETTLE_MS = 1500

export interface DragValueOptions {
  /** The value the hub serves for this control. */
  readonly served: number
  /** Sends the command, once per release. */
  readonly onCommit: (value: number) => void
  readonly settleMs?: number
}

/** The change event a range input hands its `onChange`. */
export interface RangeChange {
  readonly currentTarget: { readonly value: string }
}

/** Spread onto a `Slider`: its value and the move / release handlers. */
export interface DragSliderProps {
  readonly value: number
  readonly onChange: (event: RangeChange) => void
  readonly onPointerUp: () => void
  readonly onPointerCancel: () => void
  readonly onKeyUp: () => void
  readonly onBlur: () => void
}

export interface DragValue {
  /** What the control shows: the hand's value during the gesture, else the served one. */
  readonly shown: number
  readonly move: (value: number) => void
  readonly commit: () => void
  readonly sliderProps: DragSliderProps
}

type Local =
  | { readonly phase: 'moving'; readonly value: number }
  | { readonly phase: 'sent'; readonly value: number; readonly servedAtRelease: number }

export function useDragValue({
  served,
  onCommit,
  settleMs = DRAG_SETTLE_MS,
}: DragValueOptions): DragValue {
  const [local, setLocal] = useState<Local | null>(null)
  const localRef = useRef<Local | null>(null)
  localRef.current = local
  const servedRef = useRef(served)
  servedRef.current = served
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  // The hub answered: what was sent, or something else than before the release.
  useEffect(() => {
    if (local?.phase !== 'sent') return
    if (served === local.value || served !== local.servedAtRelease) setLocal(null)
  }, [served, local])

  // No answer in time: show the served value again.
  useEffect(() => {
    if (local?.phase !== 'sent') return
    const timer = setTimeout(() => setLocal(null), settleMs)
    return () => clearTimeout(timer)
  }, [local, settleMs])

  const move = useCallback((value: number): void => {
    const next: Local = { phase: 'moving', value }
    localRef.current = next
    setLocal(next)
  }, [])

  const commit = useCallback((): void => {
    const current = localRef.current
    if (current?.phase !== 'moving') return
    const next: Local = {
      phase: 'sent',
      value: current.value,
      servedAtRelease: servedRef.current,
    }
    localRef.current = next
    setLocal(next)
    commitRef.current(current.value)
  }, [])

  // The hand may leave the input before letting go; the input then never sees
  // the pointerup. Listen on the window while moving so the release commits.
  const moving = local?.phase === 'moving'
  useEffect(() => {
    if (!moving || typeof window === 'undefined') return
    window.addEventListener('pointerup', commit)
    window.addEventListener('pointercancel', commit)
    return () => {
      window.removeEventListener('pointerup', commit)
      window.removeEventListener('pointercancel', commit)
    }
  }, [moving, commit])

  const shown = local?.value ?? served
  return {
    shown,
    move,
    commit,
    sliderProps: {
      value: shown,
      onChange: (event) => move(Number(event.currentTarget.value)),
      onPointerUp: commit,
      onPointerCancel: commit,
      onKeyUp: commit,
      onBlur: commit,
    },
  }
}
