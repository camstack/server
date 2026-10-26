/**
 * The Integrations page layout, remembered per browser.
 *
 * There is no per-user UI-preference store. This follows the page-size
 * pattern: `localStorage`, every read and write guarded, default `table`.
 * A blocked or missing store keeps the choice for this page only.
 */
import { useCallback, useState } from 'react'

export const INTEGRATIONS_VIEW_STORAGE_KEY = 'camstack.admin.integrations.view'

const VIEWS = ['table', 'grid'] as const

export type IntegrationsView = (typeof VIEWS)[number]

export type SetIntegrationsView = (next: IntegrationsView) => void

function isView(value: string | null): value is IntegrationsView {
  return value === 'table' || value === 'grid'
}

function browserStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

export function readIntegrationsView(storage: Storage | null = browserStorage()): IntegrationsView {
  if (storage === null) return 'table'
  try {
    const raw = storage.getItem(INTEGRATIONS_VIEW_STORAGE_KEY)
    return isView(raw) ? raw : 'table'
  } catch {
    return 'table'
  }
}

export function writeIntegrationsView(
  view: IntegrationsView,
  storage: Storage | null = browserStorage(),
): void {
  if (storage === null) return
  try {
    storage.setItem(INTEGRATIONS_VIEW_STORAGE_KEY, view)
  } catch {
    /* storage blocked or full — the choice lasts for this page only */
  }
}

export function useIntegrationsView(): readonly [IntegrationsView, SetIntegrationsView] {
  const [view, setView] = useState<IntegrationsView>(() => readIntegrationsView())
  const update = useCallback<SetIntegrationsView>((next) => {
    setView(next)
    writeIntegrationsView(next)
  }, [])
  return [view, update] as const
}
