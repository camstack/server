/**
 * Player overlay registry — pluggable layers + toolbar buttons for
 * the device-detail live-frame `StreamPanel`.
 *
 * Why a registry: previously `StreamPanelContent` hardcoded each
 * overlay (PTZ, intercom toggle, zone editor) and threaded the
 * editing state by hand. Adding a new feature (audio waveform,
 * detection bbox tracker, recording controls, …) meant another
 * round of plumbing through the host file and StreamPanel's prop
 * surface. The registry lets a sibling component (Detection tab,
 * Live Stats tab, an addon-page extension) declare its own layer
 * imperatively via a hook, and the host renders whatever's
 * registered.
 *
 * Two registries live side-by-side:
 *
 *   1. **layers** — absolute-positioned React nodes drawn over the
 *      video frame (zones polygon canvas, motion bbox overlay,
 *      audio waveform). Rendered ordered by `order` (lower first
 *      → bottom; higher → top); the last-registered layer wins
 *      ties.
 *
 *   2. **toolbar buttons** — controls surfaced in the player's
 *      always-visible toolbar cluster (next to Intercom + Play/Stop).
 *      Each carries an icon, label, controlled `active` flag, and
 *      a click handler. The host (StreamPanel) renders them
 *      uniformly; tone variants stay simple (`'default' | 'primary'`).
 *
 * Lifecycle: hooks register their layer / button on mount and
 * unregister on unmount, so swapping tabs (e.g. leaving Detection)
 * automatically tears down the registration. Re-registering with
 * the same `id` replaces the prior entry — meaning a single hook
 * call can update its overlay/button props on every render without
 * leaking entries.
 *
 * Provider scope: typically wraps the whole device-detail subtree
 * so the StreamPanel + every tab share the same registry. One
 * provider per `deviceId`; switching device IDs unmounts the
 * provider naturally.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type JSX,
} from 'react'
import { createSharedContext } from '../lib/shared-context'

// ── Layer registry ────────────────────────────────────────────────────────────

export interface PlayerOverlayLayer {
  readonly id: string
  /** Lower = bottom. Built-in layers (PTZ overlay, detection overlay)
   *  are drawn at order 0; addon-contributed layers should pick a
   *  higher value (e.g. 100) to land on top. */
  readonly order: number
  readonly node: ReactNode
}

// ── Toolbar registry ─────────────────────────────────────────────────────────

export interface PlayerToolbarButton {
  readonly id: string
  /** Lower = leftmost in the toolbar cluster. */
  readonly order: number
  /** Icon node — typically a `<svg>` or lucide-react icon. The host
   *  renders it inside a button shell; the icon component is
   *  responsible for its own sizing (h-3 w-3 by convention). */
  readonly icon: ReactNode
  /** Visible label on wider breakpoints; collapses to icon-only on
   *  narrow widths. */
  readonly label: string
  /** Title/tooltip for the rendered button. Defaults to `label`. */
  readonly title?: string
  /** Controlled active state — drives the highlight (primary tint). */
  readonly active: boolean
  /** Tone variant for the inactive state. `'primary'` reads as a
   *  call-to-action (e.g. "Snapshot"); `'default'` is a neutral
   *  toggle. */
  readonly tone?: 'default' | 'primary'
  /** Disable the button when the host is mid-transition. */
  readonly disabled?: boolean
  readonly onClick: () => void
}

interface RegistryShape {
  readonly layers: ReadonlyMap<string, PlayerOverlayLayer>
  readonly buttons: ReadonlyMap<string, PlayerToolbarButton>
}

interface RegistryActions {
  setLayer(layer: PlayerOverlayLayer): void
  removeLayer(id: string): void
  setButton(button: PlayerToolbarButton): void
  removeButton(id: string): void
}

const PlayerOverlaysStateContext = createSharedContext<RegistryShape | null>(
  'camstack:player-overlays-state',
  null,
)
const PlayerOverlaysActionsContext = createSharedContext<RegistryActions | null>(
  'camstack:player-overlays-actions',
  null,
)

export interface PlayerOverlaysProviderProps {
  readonly children: ReactNode
}

export function PlayerOverlaysProvider({ children }: PlayerOverlaysProviderProps): JSX.Element {
  const [layers, setLayers] = useState<ReadonlyMap<string, PlayerOverlayLayer>>(() => new Map())
  const [buttons, setButtons] = useState<ReadonlyMap<string, PlayerToolbarButton>>(() => new Map())

  const setLayer = useCallback((layer: PlayerOverlayLayer) => {
    setLayers((prev) => {
      const next = new Map(prev)
      next.set(layer.id, layer)
      return next
    })
  }, [])
  const removeLayer = useCallback((id: string) => {
    setLayers((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])
  const setButton = useCallback((button: PlayerToolbarButton) => {
    setButtons((prev) => {
      const next = new Map(prev)
      next.set(button.id, button)
      return next
    })
  }, [])
  const removeButton = useCallback((id: string) => {
    setButtons((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const stateValue = useMemo<RegistryShape>(() => ({ layers, buttons }), [layers, buttons])
  const actionsValue = useMemo<RegistryActions>(
    () => ({ setLayer, removeLayer, setButton, removeButton }),
    [setLayer, removeLayer, setButton, removeButton],
  )

  return (
    <PlayerOverlaysStateContext.Provider value={stateValue}>
      <PlayerOverlaysActionsContext.Provider value={actionsValue}>
        {children}
      </PlayerOverlaysActionsContext.Provider>
    </PlayerOverlaysStateContext.Provider>
  )
}

// ── Read hooks ────────────────────────────────────────────────────────────────

/** Snapshot of registered layers ordered by `order` (asc, ties resolved
 *  by insertion order of the underlying Map). Returns `[]` outside a
 *  provider. */
export function usePlayerOverlayLayers(): readonly PlayerOverlayLayer[] {
  const state = useContext(PlayerOverlaysStateContext)
  return useMemo(() => {
    if (!state) return []
    return [...state.layers.values()].toSorted((a, b) => a.order - b.order)
  }, [state])
}

/** Snapshot of registered toolbar buttons, ordered by `order` (asc). */
export function usePlayerToolbarButtons(): readonly PlayerToolbarButton[] {
  const state = useContext(PlayerOverlaysStateContext)
  return useMemo(() => {
    if (!state) return []
    return [...state.buttons.values()].toSorted((a, b) => a.order - b.order)
  }, [state])
}

// ── Registration hooks ───────────────────────────────────────────────────────

/**
 * Register an overlay layer for the lifetime of the calling component.
 * Re-registers on every render with the latest spec; auto-unregisters
 * on unmount. Pass `null` to skip registration when the layer is
 * conditionally enabled (the hook still runs every render — keeps
 * react-hook order stable across spec === null toggles).
 *
 * Callers that build the spec inline should memoise it (`useMemo`)
 * to avoid re-registering on every parent render — context-write
 * effects depend on referential equality of the spec object.
 */
export function usePlayerOverlayLayer(spec: PlayerOverlayLayer | null): void {
  const actions = useContext(PlayerOverlaysActionsContext)
  useEffect(() => {
    if (!actions || !spec) return undefined
    actions.setLayer(spec)
    return () => actions.removeLayer(spec.id)
  }, [actions, spec])
}

/** Same shape as `usePlayerOverlayLayer`, scoped to toolbar buttons. */
export function usePlayerToolbarButton(spec: PlayerToolbarButton | null): void {
  const actions = useContext(PlayerOverlaysActionsContext)
  useEffect(() => {
    if (!actions || !spec) return undefined
    actions.setButton(spec)
    return () => actions.removeButton(spec.id)
  }, [actions, spec])
}
