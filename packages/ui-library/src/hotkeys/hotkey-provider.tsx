import {
  type JSX,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
}

interface Binding {
  readonly id: number
  readonly combo: HotkeyCombo
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
}

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

  const registry = useMemo<Registry>(
    () => ({
      addBinding: (binding) => {
        stateRef.current = {
          ...stateRef.current,
          bindings: [...stateRef.current.bindings, binding],
        }
        return () => {
          stateRef.current = {
            ...stateRef.current,
            bindings: stateRef.current.bindings.filter((b) => b.id !== binding.id),
          }
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
    }),
    [],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void =>
      dispatch(stateRef.current, event, effectivePlatform)
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [effectivePlatform])

  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
}

let nextBindingId = 0

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
      scope,
      handlerRef,
      preventDefault,
      allowInInput,
    })
  }, [registry, enabled, combo, scope, preventDefault, allowInInput])
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
