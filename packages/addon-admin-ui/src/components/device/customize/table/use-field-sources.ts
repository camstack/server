/**
 * The fleet as the per-field rows need it: device names for the source text and,
 * per source device, whether the fleet lists it and whether it is online. While
 * the fleet is unread `presence` is null — a row claims neither bound nor missing (D315).
 */
import { compositionSourceKey } from '@camstack/types'
import { useDeviceManagerListAll } from '@camstack/ui-library'
import { useMemo } from 'react'
import type { SourcePresence } from './field-rows'

export interface FieldSources {
  readonly names: ReadonlyMap<string, string>
  readonly presence: ReadonlyMap<string, SourcePresence> | null
}

const NONE: FieldSources = { names: new Map(), presence: null }

export function useFieldSources(enabled: boolean): FieldSources {
  const all = useDeviceManagerListAll({ projection: 'slim' }, { enabled })
  return useMemo(() => {
    if (all.data === undefined) return NONE
    const names = new Map<string, string>()
    const presence = new Map<string, SourcePresence>()
    for (const d of all.data) {
      const key = compositionSourceKey({
        addonId: d.addonId,
        stableId: d.stableId,
      })
      names.set(key, d.name)
      presence.set(key, d.online ? 'answering' : 'offline')
    }
    return { names, presence }
  }, [all.data])
}
