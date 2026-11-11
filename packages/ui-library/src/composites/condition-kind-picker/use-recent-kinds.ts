import { AUTOMATION_LEAF_KINDS, type AutomationLeafKind } from '@camstack/types'
import { useCallback, useState } from 'react'
import { rememberRecentKind } from './condition-kind-picker-model'

const STORAGE_PREFIX = 'camstack.conditionKindPicker.recent.'

function isKind(value: unknown): value is AutomationLeafKind {
  return AUTOMATION_LEAF_KINDS.some((kind) => kind === value)
}

function read(key: string): readonly AutomationLeafKind[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_PREFIX + key) ?? '[]')
    return Array.isArray(raw) ? raw.filter(isKind) : []
  } catch {
    return []
  }
}

/**
 * The kinds one picker offered last time, newest first — a per-viewer
 * convenience only: storage can be absent or throw, and the picker is whole
 * without it.
 */
export interface RecentKinds {
  readonly kinds: readonly AutomationLeafKind[]
  readonly push: (kind: AutomationLeafKind) => void
}

export function useRecentKinds(key: string | undefined): RecentKinds {
  const [kinds, setKinds] = useState<readonly AutomationLeafKind[]>(() =>
    key === undefined ? [] : read(key),
  )
  const push = useCallback(
    (kind: AutomationLeafKind) => {
      if (key === undefined) return
      const next = rememberRecentKind(read(key), kind)
      try {
        window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(next))
      } catch {
        // Storage is a convenience; ignore a refusal.
      }
      setKinds(next)
    },
    [key],
  )
  return { kinds, push }
}
