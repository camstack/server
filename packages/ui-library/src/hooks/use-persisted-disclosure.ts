/**
 * usePersistedDisclosure — an open / closed choice the viewer made, remembered
 * per viewer under the caller's key (one key per section and device).
 *
 * `null` means the viewer never chose. The caller then shows its own default,
 * which may follow the data (the Consumables section opens itself while an
 * item needs attention) — the default is never written, so it can change with
 * the data until the viewer picks.
 *
 * Storage is a convenience, never a requirement: every read and write is
 * guarded, and a blocked / private-mode storage means the choice lasts until
 * the page is left. A stored value this hook did not write is ignored.
 */
import { useCallback, useState } from 'react'

const OPEN = 'open'
const CLOSED = 'closed'

export type SetDisclosure = (open: boolean) => void

function readStored(key: string | null): boolean | null {
  if (key === null || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === OPEN) return true
    if (raw === CLOSED) return false
    return null
  } catch {
    return null
  }
}

function writeStored(key: string | null, open: boolean): void {
  if (key === null || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, open ? OPEN : CLOSED)
  } catch {
    /* storage blocked or full — the choice lasts for this page only */
  }
}

interface DisclosureChoice {
  readonly key: string | null
  readonly open: boolean | null
}

/** @returns `[choice, setChoice]` — `choice` is `null` until the viewer picks. */
export function usePersistedDisclosure(
  storageKey: string | null,
): readonly [boolean | null, SetDisclosure] {
  const [choice, setChoice] = useState<DisclosureChoice>(() => ({
    key: storageKey,
    open: readStored(storageKey),
  }))
  // A new key (another device on the same mounted page) reads its own choice.
  const current: DisclosureChoice =
    choice.key === storageKey ? choice : { key: storageKey, open: readStored(storageKey) }
  if (current !== choice) setChoice(current)

  const update = useCallback<SetDisclosure>(
    (open) => {
      setChoice({ key: storageKey, open })
      writeStored(storageKey, open)
    },
    [storageKey],
  )

  return [current.open, update] as const
}
