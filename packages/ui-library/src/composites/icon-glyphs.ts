/**
 * icon-glyphs — the web glyph table for the WHOLE icon catalog (D854).
 *
 * `@camstack/types` owns the keys; this module owns the drawing. Every
 * `ICON_KEYS` member resolves to a `lucide-react` component, without one
 * static import per icon and without putting the whole set in the initial
 * chunk:
 *
 *  - a small synchronous FAST table (`FAST_ICON_GLYPHS`, the icons the device
 *    type/role meta tables already import) answers on first paint;
 *  - everything else comes from a SINGLE lazily imported table, fetched the
 *    first time something asks for a glyph the fast table lacks. One chunk, not
 *    one request per icon. It is lucide's per-icon INDEX module, not the package
 *    barrel: the barrel is also what every static import resolves to, so a
 *    dynamic `import('lucide-react')` is shared with the initial graph and the
 *    bundler hoists all ~1,700 icons into an initial chunk (measured: +484 KB).
 *    The index module is reached only from here, so its icons stay lazy.
 *
 * `resolveDisplayIcon` stays synchronous so existing call sites keep their
 * shape: it answers from the fast table, then from the full table once loaded,
 * and otherwise returns `undefined` AND starts the load. A component that
 * draws the result must subscribe with {@link useDisplayIconResolver} so it
 * re-renders when the table arrives — `undefined` then means "fall through to
 * the next precedence level for now", exactly as it always meant "this build
 * cannot draw it".
 *
 * If the lazy chunk fails to load the failure is recorded
 * ({@link iconGlyphsFailed}) and not retried until reload; the fast table keeps
 * answering.
 */
// oxlint-disable-next-line typescript/triple-slash-reference -- the ambient shim must travel with this module wherever a consumer compiles it from source
/// <reference path="../lucide-icons-module.d.ts" />
import { canonicalIconKey } from '@camstack/types'
import type { LucideIcon } from 'lucide-react'
import { useMemo, useSyncExternalStore } from 'react'
import { FAST_ICON_GLYPHS } from './device-meta'

type GlyphTable = Readonly<Record<string, LucideIcon>>

let fullTable: GlyphTable | undefined
let pending: Promise<void> | undefined
let failure: unknown
let version = 0
const listeners = new Set<() => void>()

function publish(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** `house` → `House`, `arrow-down-0-1` → `ArrowDown01`: lucide's export naming. */
export function lucideExportName(key: string): string {
  return key
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * Load the full glyph table once. Resolves when it is available; rejects (once)
 * if the chunk could not be fetched. Safe to call repeatedly.
 */
export function loadIconGlyphs(): Promise<void> {
  if (fullTable !== undefined) return Promise.resolve()
  if (failure !== undefined) return Promise.reject(failure)
  pending ??= import('lucide-react/dist/esm/icons/index.js').then(
    (module: GlyphTable) => {
      fullTable = module
      publish()
    },
    (error: unknown) => {
      failure = error
      publish()
      throw error
    },
  )
  return pending
}

/** Has the lazy glyph chunk failed to load? (Then only the fast table answers.) */
export function iconGlyphsFailed(): boolean {
  return failure !== undefined
}

/** Is the full table loaded? */
export function iconGlyphsLoaded(): boolean {
  return fullTable !== undefined
}

/**
 * The glyph for a stored icon value (a catalog key, or a spelling that
 * resolves to one), or `undefined` when it names no catalog icon — or when its
 * glyph is not loaded YET, in which case the load is started.
 */
export function resolveDisplayIcon(name: string): LucideIcon | undefined {
  const key = canonicalIconKey(name)
  if (key === undefined) return undefined
  const fast = FAST_ICON_GLYPHS[key]
  if (fast !== undefined) return fast
  if (fullTable !== undefined) return fullTable[lucideExportName(key)]
  if (failure === undefined) loadIconGlyphs().catch(() => undefined)
  return undefined
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getVersion = (): number => version

/**
 * Subscribe a component to the lazy glyph table. Call it in any component that
 * draws the result of `resolveDisplayIcon` (directly or through a helper such
 * as `deviceLeadIcon`): it re-renders once when the table arrives, so a glyph
 * that was `undefined` a moment ago is drawn.
 */
export function useIconGlyphsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion)
}

/**
 * `resolveDisplayIcon` for a component: the returned function changes identity
 * when the full table arrives, so anything memoised on it recomputes.
 */
export function useDisplayIconResolver(): (name: string) => LucideIcon | undefined {
  const loadedVersion = useIconGlyphsVersion()
  // The version is the memo key on purpose: a new table must produce a new
  // resolver identity so anything memoised on it recomputes.
  return useMemo(() => (name: string) => resolveDisplayIcon(name), [loadedVersion])
}
