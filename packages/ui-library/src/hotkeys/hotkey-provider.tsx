import {
  type JSX,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import {
  type HotkeyCombo,
  type HotkeyPlatform,
  detectPlatform,
  matchesCombo,
  parseCombo,
} from './combo'

/** Returning `false` declines the event: nothing is prevented and the next binding is tried. */
export type HotkeyHandler = (event: KeyboardEvent) => void | boolean

export interface UseHotkeyOptions {
  /** Defaults to the enclosing `HotkeyScope`, else the page. */
  readonly scope?: string
  readonly enabled?: boolean
  /** Default true — only when the handler did not decline. */
  readonly preventDefault?: boolean
  /** Fire while typing in a field. Default: only combos that carry `mod`. */
  readonly allowInInput?: boolean
  /** What the binding does, in the operator's words; shown by the read-only hotkey list. */
  readonly label?: string
}

/** One binding as the registry exposes it for display. */
export interface RegisteredHotkey {
  readonly combo: HotkeyCombo
  readonly scope: string
  readonly label: string | null
}

interface Binding {
  readonly id: number
  readonly combo: HotkeyCombo
  readonly label: string | null
  readonly scope: string
  readonly handlerRef: { current: HotkeyHandler }
  readonly preventDefault: boolean
  readonly allowInInput: boolean
}

interface ScopeEntry {
  readonly id: string
  readonly modal: boolean
}

interface RegistryState {
  readonly bindings: readonly Binding[]
  readonly scopes: readonly ScopeEntry[]
}

export const PAGE_SCOPE = 'page'
/** Asked last, after the page: a global handler that yields to whatever the page registers. */
export const FALLBACK_SCOPE = 'fallback'

interface Registry {
  addBinding: (binding: Binding) => () => void
  addScope: (scope: ScopeEntry) => () => void
  subscribe: (listener: () => void) => () => void
  snapshot: () => readonly RegisteredHotkey[]
}

const NO_HOTKEYS: readonly RegisteredHotkey[] = []

const RegistryContext = createContext<Registry | null>(null)
const ScopeContext = createContext<string>(PAGE_SCOPE)

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

/**
 * Scopes stack in mount order; the newest enabled one is asked first. A `modal`
 * scope (an open dialog) ends the walk: what sits under it is not reachable.
 * Inside a scope the newest binding wins; a handler that returns `false` hands
 * over to the next one.
 */
function dispatch(state: RegistryState, event: KeyboardEvent, platform: HotkeyPlatform): void {
  if (event.isComposing || event.keyCode === 229) return
  const typing = isTypingTarget(event.target)
  const order: readonly string[] = [
    ...[...state.scopes].reverse().map((s) => s.id),
    PAGE_SCOPE,
    FALLBACK_SCOPE,
  ]
  for (const scopeId of order) {
    const candidates = state.bindings
      .filter((b) => b.scope === scopeId && matchesCombo(event, b.combo, platform))
      .reverse()
    for (const binding of candidates) {
      if (typing && !binding.allowInInput) continue
      if (binding.handlerRef.current(event) === false) continue
      if (binding.preventDefault) event.preventDefault()
      return
    }
    const entry = state.scopes.find((s) => s.id === scopeId)
    if (entry?.modal) return
  }
}

export interface HotkeyProviderProps {
  readonly children: ReactNode
  /** Override platform detection (tests). */
  readonly platform?: HotkeyPlatform
}

export function HotkeyProvider({ children, platform }: HotkeyProviderProps): JSX.Element {
  const stateRef = useRef<RegistryState>({ bindings: [], scopes: [] })
  const effectivePlatform = platform ?? detectPlatform()

  const listenersRef = useRef<ReadonlySet<() => void>>(new Set())
  const listRef = useRef<readonly RegisteredHotkey[]>(NO_HOTKEYS)

  const registry = useMemo<Registry>(() => {
    const publish = (): void => {
      listRef.current = distinctHotkeys(stateRef.current.bindings)
      for (const listener of listenersRef.current) listener()
    }
    return {
      subscribe: (listener) => {
        listenersRef.current = new Set([...listenersRef.current, listener])
        return () => {
          listenersRef.current = new Set([...listenersRef.current].filter((l) => l !== listener))
        }
      },
      snapshot: () => listRef.current,
      addBinding: (binding) => {
        stateRef.current = {
          ...stateRef.current,
          bindings: [...stateRef.current.bindings, binding],
        }
        publish()
        return () => {
          stateRef.current = {
            ...stateRef.current,
            bindings: stateRef.current.bindings.filter((b) => b.id !== binding.id),
          }
          publish()
        }
      },
      addScope: (scope) => {
        stateRef.current = {
          ...stateRef.current,
          scopes: [...stateRef.current.scopes, scope],
        }
        return () => {
          stateRef.current = {
            ...stateRef.current,
            scopes: stateRef.current.scopes.filter((s) => s !== scope),
          }
        }
      },
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void =>
      dispatch(stateRef.current, event, effectivePlatform)
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [effectivePlatform])

  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
}

let nextBindingId = 0

function distinctHotkeys(bindings: readonly Binding[]): readonly RegisteredHotkey[] {
  const seen = new Map<string, RegisteredHotkey>()
  for (const b of bindings) {
    const key = `${b.scope}|${b.combo}`
    const prev = seen.get(key)
    if (!prev || (prev.label === null && b.label !== null)) {
      seen.set(key, { combo: b.combo, scope: b.scope, label: b.label })
    }
  }
  return [...seen.values()]
}

/**
 * The bindings registered below the `HotkeyProvider` right now (read-only; there
 * is no rebinding). Empty without a provider.
 */
export function useRegisteredHotkeys(): readonly RegisteredHotkey[] {
  const registry = useContext(RegistryContext)
  return useSyncExternalStore(
    registry ? registry.subscribe : noSubscribe,
    registry ? registry.snapshot : emptySnapshot,
  )
}

const noSubscribe = (): (() => void) => () => undefined
const emptySnapshot = (): readonly RegisteredHotkey[] => NO_HOTKEYS

/**
 * Bind a combo for the life of the component. Without a `HotkeyProvider` above
 * it does nothing, so the browser keeps its own shortcut.
 */
export function useHotkey(
  combo: HotkeyCombo,
  handler: HotkeyHandler,
  options: UseHotkeyOptions = {},
): void {
  const registry = useContext(RegistryContext)
  const inheritedScope = useContext(ScopeContext)
  const handlerRef = useRef<HotkeyHandler>(handler)
  handlerRef.current = handler

  const scope = options.scope ?? inheritedScope
  const enabled = options.enabled ?? true
  const preventDefault = options.preventDefault ?? true
  const allowInInput = options.allowInInput ?? parseCombo(combo).mod

  useEffect(() => {
    if (!registry || !enabled) return undefined
    nextBindingId += 1
    return registry.addBinding({
      id: nextBindingId,
      combo,
      label: options.label ?? null,
      scope,
      handlerRef,
      preventDefault,
      allowInInput,
    })
  }, [registry, enabled, combo, scope, preventDefault, allowInInput, options.label])
}

export interface HotkeyScopeProps {
  readonly id: string
  readonly children: ReactNode
  /** Default true. Turn off while the surface is closed. */
  readonly enabled?: boolean
  /** Shadows every scope under it, the page included. Default false. */
  readonly modal?: boolean
}

/** Bindings made below this component belong to `id`; while enabled it is the topmost scope. */
export function HotkeyScope({
  id,
  children,
  enabled = true,
  modal = false,
}: HotkeyScopeProps): JSX.Element {
  const registry = useContext(RegistryContext)
  useEffect(() => {
    if (!registry || !enabled) return undefined
    return registry.addScope({ id, modal })
  }, [registry, enabled, id, modal])
  return <ScopeContext.Provider value={id}>{children}</ScopeContext.Provider>
}
