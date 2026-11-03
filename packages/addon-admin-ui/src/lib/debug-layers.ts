/**
 * Debug layers (planning#362): the pure half of the admin's layer inspector.
 *
 * On an installed iOS PWA the mobile top bar renders blurred and a grey
 * rounded element sits on the left edge, and it does not reproduce in
 * Chromium. The inspector outlines every element near the top of the viewport
 * that can paint over, blur or dim what is behind it. This file decides WHICH
 * elements qualify and whether the mode is on; the DOM walk is
 * `components/debug/DebugLayers.tsx`.
 */

/** How far from the top of the viewport an element must start to be considered. */
export const DEBUG_LAYERS_TOP_PX = 120

export const DEBUG_LAYERS_STORAGE_KEY = 'camstack.debugLayers'

/** The computed-style properties the classifier reads (a `CSSStyleDeclaration` satisfies it). */
export interface StyleLike {
  readonly position: string
  readonly zIndex: string
  readonly opacity: string
  readonly filter: string
  readonly backdropFilter: string
  readonly webkitBackdropFilter: string
  readonly transform: string
  readonly perspective: string
  readonly isolation: string
  readonly mixBlendMode: string
  readonly willChange: string
}

export interface RectLike {
  readonly top: number
  readonly bottom: number
  readonly width: number
  readonly height: number
}

export type LayerReason =
  | 'fixed'
  | 'sticky'
  | 'backdrop-filter'
  | 'filter'
  | 'opacity'
  | 'transform'
  | 'perspective'
  | 'isolation'
  | 'mix-blend-mode'
  | 'will-change'

export interface LayerFinding {
  readonly reasons: readonly LayerReason[]
  /** The z-index as computed (`auto` when none). */
  readonly zIndex: string
}

const STACKING_WILL_CHANGE = /(transform|opacity|filter|perspective)/

function isSet(value: string): boolean {
  return value !== '' && value !== 'none'
}

/**
 * The reasons an element is a layer worth outlining, or `null` when it is
 * not one, or sits entirely outside the top band of the viewport.
 */
export function classifyLayer(
  style: StyleLike,
  rect: RectLike,
  topPx: number = DEBUG_LAYERS_TOP_PX,
): LayerFinding | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  if (rect.top >= topPx || rect.bottom <= 0) return null
  const reasons: LayerReason[] = []
  if (style.position === 'fixed') reasons.push('fixed')
  if (style.position === 'sticky') reasons.push('sticky')
  if (isSet(style.backdropFilter) || isSet(style.webkitBackdropFilter)) {
    reasons.push('backdrop-filter')
  }
  if (isSet(style.filter)) reasons.push('filter')
  const opacity = Number.parseFloat(style.opacity)
  if (Number.isFinite(opacity) && opacity < 1) reasons.push('opacity')
  if (isSet(style.transform)) reasons.push('transform')
  if (isSet(style.perspective)) reasons.push('perspective')
  if (style.isolation === 'isolate') reasons.push('isolation')
  if (style.mixBlendMode !== '' && style.mixBlendMode !== 'normal') reasons.push('mix-blend-mode')
  if (STACKING_WILL_CHANGE.test(style.willChange)) reasons.push('will-change')
  return reasons.length === 0 ? null : { reasons, zIndex: style.zIndex }
}

/** The label of a finding: `tag.first-classes · z=… · reason, reason`. */
export function describeLayer(
  tag: string,
  classes: string,
  dataAttr: string | null,
  finding: LayerFinding,
): string {
  const named =
    dataAttr !== null && dataAttr !== ''
      ? `[${dataAttr}]`
      : classes
          .split(/\s+/)
          .filter((c) => c !== '')
          .slice(0, 3)
          .map((c) => `.${c}`)
          .join('')
  return `${tag.toLowerCase()}${named} z=${finding.zIndex} ${finding.reasons.join('+')}`
}

/**
 * Whether the mode is on. `?debugLayers=1` turns it on and remembers that for
 * the session (the installed PWA navigates without the query), `?debugLayers=0`
 * turns it off and forgets; with no query the remembered value decides.
 */
export function resolveDebugLayers(
  search: string,
  stored: string | null,
): { readonly on: boolean; readonly persist: '1' | null | 'keep' } {
  const asked = new URLSearchParams(search).get('debugLayers')
  if (asked === '1') return { on: true, persist: '1' }
  if (asked === '0') return { on: false, persist: null }
  return { on: stored === '1', persist: 'keep' }
}

/** Remembers the "no backdrop blur" experiment for the session, beside the mode flag. */
export const DEBUG_NO_BLUR_STORAGE_KEY = 'camstack.debugLayers.noBlur'

/** Remember the bisect switches that default ON; the stored value `0` means switched off. */
export const DEBUG_OUTLINES_STORAGE_KEY = 'camstack.debugLayers.outlines'
export const DEBUG_TOP_LAYER_STORAGE_KEY = 'camstack.debugLayers.topLayer'

/** Class on `<html>` while the experiment runs; the rule that uses it is in `index.css`. */
export const DEBUG_NO_BLUR_CLASS = 'debug-no-backdrop-blur'

/** The slice of `Storage` the flags need (a `sessionStorage` satisfies it). */
export interface FlagStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface DebugLayersState {
  readonly on: boolean
  readonly noBlur: boolean
  /** Bisect: draw the outlines and labels (default on). */
  readonly outlines: boolean
  /** Bisect: raise the overlay into the browser's top layer (default on). */
  readonly topLayer: boolean
}

export interface DebugLayersStore {
  getState(): DebugLayersState
  subscribe(listener: () => void): () => void
  setOn(on: boolean): void
  setNoBlur(noBlur: boolean): void
  setOutlines(outlines: boolean): void
  setTopLayer(topLayer: boolean): void
}

function safeGet(storage: FlagStorage | null, key: string): string | null {
  try {
    return storage === null ? null : storage.getItem(key)
  } catch {
    return null
  }
}

function safeWrite(storage: FlagStorage | null, key: string, value: '1' | '0' | null): void {
  try {
    if (storage === null) return
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, value)
  } catch {
    // Private mode: the in-memory state still holds for this page load.
  }
}

/**
 * The one place the flags change. It starts from the query and the session
 * (`resolveDebugLayers`), keeps `storage` in step, and notifies subscribers,
 * so the in-app switch and `?debugLayers=` flip the same flag.
 */
export function createDebugLayersStore(
  storage: FlagStorage | null,
  search: string,
): DebugLayersStore {
  const decision = resolveDebugLayers(search, safeGet(storage, DEBUG_LAYERS_STORAGE_KEY))
  if (decision.persist !== 'keep') safeWrite(storage, DEBUG_LAYERS_STORAGE_KEY, decision.persist)
  let state: DebugLayersState = {
    on: decision.on,
    noBlur: safeGet(storage, DEBUG_NO_BLUR_STORAGE_KEY) === '1',
    outlines: safeGet(storage, DEBUG_OUTLINES_STORAGE_KEY) !== '0',
    topLayer: safeGet(storage, DEBUG_TOP_LAYER_STORAGE_KEY) !== '0',
  }
  const listeners = new Set<() => void>()
  const publish = (next: DebugLayersState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setOn: (on) => {
      safeWrite(storage, DEBUG_LAYERS_STORAGE_KEY, on ? '1' : null)
      // Turning the mode off also ends the experiment: nothing stays altered unseen.
      if (!on) {
        safeWrite(storage, DEBUG_NO_BLUR_STORAGE_KEY, null)
        safeWrite(storage, DEBUG_OUTLINES_STORAGE_KEY, null)
        safeWrite(storage, DEBUG_TOP_LAYER_STORAGE_KEY, null)
        publish({ on, noBlur: false, outlines: true, topLayer: true })
        return
      }
      publish({ ...state, on })
    },
    setNoBlur: (noBlur) => {
      safeWrite(storage, DEBUG_NO_BLUR_STORAGE_KEY, noBlur ? '1' : null)
      publish({ ...state, noBlur })
    },
    setOutlines: (outlines) => {
      safeWrite(storage, DEBUG_OUTLINES_STORAGE_KEY, outlines ? null : '0')
      publish({ ...state, outlines })
    },
    setTopLayer: (topLayer) => {
      safeWrite(storage, DEBUG_TOP_LAYER_STORAGE_KEY, topLayer ? null : '0')
      publish({ ...state, topLayer })
    },
  }
}

/** The compositing-relevant styles the panel prints for one element. */
export const COMPOSITING_PROPS = [
  'transform',
  'will-change',
  'position',
  'backdrop-filter',
  'filter',
  'opacity',
] as const

export type CompositingProp = (typeof COMPOSITING_PROPS)[number]

/** One `prop: value` line per property, `n/a` when the element is absent. */
export function formatCompositing(
  read: ((prop: CompositingProp) => string) | null,
): readonly string[] {
  return COMPOSITING_PROPS.map((prop) => `${prop}: ${read === null ? 'n/a' : read(prop) || '-'}`)
}
