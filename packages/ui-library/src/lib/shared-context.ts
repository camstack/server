/**
 * Cross-bundle React Context sharing.
 *
 * Addon page bundles (benchmark, etc.) ship their own bundled copy of
 * `@camstack/ui-library`. Without sharing, each bundle calls
 * `createContext()` and gets a fresh Context instance — so when the
 * bundle's hook reads from this Context, it doesn't match the host
 * admin-ui's <Provider> tree, and `useContext()` returns the default
 * value (typically `null`) which often causes a `must be used within
 * Provider` throw.
 *
 * This helper stashes Context instances on `globalThis` keyed by a
 * unique name, so the SECOND-evaluated copy reuses the host's
 * instance instead of creating a duplicate.
 *
 * Boot order:
 *   1. admin-ui's main.tsx evaluates first → globalThis Map is empty
 *      → creates Context, stores it under `name`.
 *   2. Addon bundle evaluates later → globalThis Map has the entry
 *      → returns the host's Context.
 *
 * Critical: pick UNIQUE `name`s. Two distinct contexts with the same
 * name will silently collide (and TypeScript can't catch it because
 * the Map is typed as `Context<unknown>`).
 */
import { createContext, type Context } from 'react'

declare global {
  // eslint-disable-next-line no-var
  var __camstackSharedContexts: Map<string, Context<unknown>> | undefined
}

export function createSharedContext<T>(name: string, defaultValue: T): Context<T> {
  if (typeof globalThis === 'undefined') {
    return createContext<T>(defaultValue)
  }
  const existingMap = globalThis.__camstackSharedContexts
  const map: Map<string, Context<unknown>> = existingMap ?? new Map<string, Context<unknown>>()
  if (!existingMap) {
    globalThis.__camstackSharedContexts = map
  }
  const existing = map.get(name)
  if (existing) {
    return existing as Context<T>
  }
  const ctx = createContext<T>(defaultValue)
  map.set(name, ctx as Context<unknown>)
  return ctx
}
