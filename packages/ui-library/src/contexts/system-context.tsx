/**
 * SystemContext — React-context plumbing for the unified `System` SDK
 * class.
 *
 * Phase 2 of the API consolidation makes `System` the single
 * client-side entry point. Pages/components reach the cluster through
 * the hooks in `../hooks/`; those hooks all read the `System`
 * instance from this context.
 *
 * The provider is intentionally stupid — it just stores the instance.
 * Lifecycle (`init()`, reconnect on auth change, watchdog) lives in
 * the host app (admin-ui's `App.tsx`) — the provider doesn't try to
 * own it because addon UIs may want to construct the System
 * differently (e.g. against a remote cluster).
 */
import { useContext, type ReactNode, type JSX } from 'react'
import type { System } from '@camstack/sdk'
import { createSharedContext } from '../lib/shared-context'

/**
 * Cross-bundle SystemContext sharing — see `lib/shared-context.ts` for
 * why this is global. Addon page bundles ship their own copy of
 * `@camstack/ui-library`, and without sharing each bundle's
 * `createContext()` produces a fresh instance that never matches the
 * host's `<SystemProvider>`.
 */
const SystemContext = createSharedContext<System | null>('camstack:system', null)

export interface SystemProviderProps {
  readonly system: System
  readonly children: ReactNode
}

export function SystemProvider({ system, children }: SystemProviderProps): JSX.Element {
  return <SystemContext.Provider value={system}>{children}</SystemContext.Provider>
}

/**
 * Read the active `System` instance from the surrounding `<SystemProvider>`.
 * Throws when no provider is mounted — every hook in this directory
 * relies on the system, so a clear error beats a silent null.
 */
export function useSystem(): System {
  const sys = useContext(SystemContext)
  if (!sys) {
    throw new Error('useSystem(): no <SystemProvider> in tree')
  }
  return sys
}

/**
 * Variant that returns `null` instead of throwing — useful for
 * components that need to render before the provider is set up
 * (boot-time splash screens etc.).
 */
export function useOptionalSystem(): System | null {
  return useContext(SystemContext)
}
