/**
 * Polls `pairing/status` every 2 s (D857) and keeps the last good answer. A
 * failed poll keeps the previous view and reports the error beside it, so a
 * blip never blanks a pairing the operator is in the middle of confirming.
 */
import { useEffect, useRef, useState } from 'react'
import { translate } from './i18n'
import { fetchPairingStatus, type PairingStatusView } from './pairing-api'

export const PAIRING_POLL_MS = 2_000

export interface PairingStatusHandle {
  readonly view: PairingStatusView | null
  /** The last poll's error, or `null` when it answered. */
  readonly error: string | null
  /** Ask now instead of waiting for the next tick. */
  readonly refresh: () => Promise<void>
}

export function usePairingStatus(intervalMs: number = PAIRING_POLL_MS): PairingStatusHandle {
  const [view, setView] = useState<PairingStatusView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  const refreshRef = useRef<() => Promise<void>>(async () => undefined)
  refreshRef.current = async () => {
    try {
      const next = await fetchPairingStatus()
      if (!alive.current) return
      setView(next)
      setError(null)
    } catch (err) {
      if (alive.current)
        setError(err instanceof Error ? err.message : translate('common.unknownError'))
    }
  }

  useEffect(() => {
    alive.current = true
    void refreshRef.current()
    const timer = setInterval(() => void refreshRef.current(), intervalMs)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [intervalMs])

  return { view, error, refresh: () => refreshRef.current() }
}
