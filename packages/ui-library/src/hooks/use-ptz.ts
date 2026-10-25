/**
 * usePTZ — PTZ control hook for device-scoped pan / tilt / zoom.
 *
 * Wraps the `ptz` capability methods through the canonical
 * `useDeviceProxy` surface — every call goes through
 * `dev.ptz?.<method>(...)` with deviceId/nodeId auto-injected. The
 * hook stays bare-bones around state (`busy`, `error`, `presets`)
 * so the operator-facing component (PTZOverlay) stays trivial.
 *
 * Returns:
 *   - `move(direction)`: discrete one-shot move (cap.move + cap.stop).
 *     Use for short pulse moves triggered by tapping a d-pad button.
 *   - `startContinuous(direction)` / `stopContinuous()`: gesture-driven
 *     continuous motion (`cap.continuousMove` + `cap.stop`). Use for
 *     long-press handlers on touch / mouse-down handlers on desktop.
 *   - `zoom('in' | 'out')`: discrete zoom step.
 *   - `goHome()`: jump to the camera's configured home. It used to be
 *     "jump to preset 0" — three providers hardcoded a vendor convention that
 *     none of this fleet's cameras honours — so it now REFUSES when nothing is
 *     configured rather than moving the head to an arbitrary slot.
 *   - `homePreset` + `setHomePreset(presetId)`: which preset home points at,
 *     and who decided. `source: 'native'` means the camera homes without a
 *     preset (ONVIF) and there is nothing to pick.
 *   - `presets` + `goToPreset(presetId)`: list and jump to named presets.
 *
 * Parametrised by the same `UseDeviceProxyTrpc` shape every other
 * device hook uses — works under admin-ui (BackendClient.trpc) and
 * addon pages (AddonPageProps.trpc) alike.
 */
import { useCallback, useEffect, useState } from 'react'
import { useDeviceProxy, type UseDeviceProxyTrpc } from './use-device-proxy'
import { isAbsentProvider } from '../lib/cap-error'

// ── Direction encoding ──────────────────────────────────────────────

/**
 * Cardinal + intercardinal direction tokens. The hook translates them
 * into normalised `(pan, tilt)` vectors before calling the underlying
 * cap so the cap surface stays speed-vector-shaped.
 */
export type PTZDirection =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'up-left'
  | 'up-right'
  | 'down-left'
  | 'down-right'

const DIRECTION_VECTORS: Record<PTZDirection, { pan: number; tilt: number }> = {
  up: { pan: 0, tilt: 1 },
  down: { pan: 0, tilt: -1 },
  left: { pan: -1, tilt: 0 },
  right: { pan: 1, tilt: 0 },
  'up-left': { pan: -1, tilt: 1 },
  'up-right': { pan: 1, tilt: 1 },
  'down-left': { pan: -1, tilt: -1 },
  'down-right': { pan: 1, tilt: -1 },
}

/** The camera's idle-return behaviour: whether, and after how long. */
interface PTZHomeReturn {
  readonly enabled: boolean
  readonly seconds: number
}

/** Which preset `goHome` targets on this camera, and who decided it. */
interface PTZHomePreset {
  readonly presetId: string | null
  readonly source: 'operator' | 'firmware' | 'native' | 'none'
}

interface PTZPreset {
  readonly id: string
  readonly name: string
  /**
   * The firmware function this id performs, or `null` for a stored position.
   * A camera's reserved band shares the preset namespace: the dispensa camera
   * returns `34 Back to origin`, `94 Remote reboot`, `95 Call OSD menu`
   * alongside the operator's own.
   */
  readonly fn: string | null
  /**
   * Whether the camera accepts a write on this id. Overwriting a reserved one
   * is what produced `PUT .../presets/34 -> HTTP 500`, which reached the
   * operator as a transport failure with no hint of the cause.
   */
  readonly writable: boolean
}

/**
 * Per-camera PTZ availability descriptor returned by `ptz.getOptions`.
 * Drives which controls the UI shows — preset save/delete is gated on
 * `supportsPresets`, and the save button disables once `maxPresets`
 * (when known) is reached.
 */
export interface PTZOptions {
  readonly hasPan: boolean
  readonly hasTilt: boolean
  readonly hasZoom: boolean
  readonly supportsPresets: boolean
  readonly maxPresets?: number
  /** Whether the camera exposes a controllable autofocus toggle. */
  readonly hasAutofocus: boolean
}

/**
 * Backwards-compatible alias for the trpc shape — historically the
 * hook took its own narrow contract; the proxy generalisation
 * supersedes that.
 */
export type PTZTrpcProxy = UseDeviceProxyTrpc

// ── Hook ────────────────────────────────────────────────────────────

export interface UsePTZOptions {
  /** Default speed (0..1) for moves when the caller omits one. */
  readonly defaultSpeed?: number
  /** Pulse duration (ms) for one-shot `move` calls. */
  readonly pulseMs?: number
  /**
   * Gate the hook's network calls. When `false`, the initial preset
   * refresh is skipped and every method becomes a no-op. Use to avoid
   * "provider not available" errors on devices that don't advertise
   * the `ptz` capability.
   */
  readonly enabled?: boolean
}

export interface UsePTZResult {
  /** One-shot directional pulse. Stops itself after `pulseMs`. */
  readonly move: (direction: PTZDirection, speed?: number) => Promise<void>
  /** Begin continuous motion in `direction` until `stopContinuous` is called. */
  readonly startContinuous: (direction: PTZDirection, speed?: number) => Promise<void>
  /** Stop any ongoing continuous motion. Idempotent. */
  readonly stopContinuous: () => Promise<void>
  /** Discrete zoom step (in or out). */
  readonly zoom: (direction: 'in' | 'out', speed?: number) => Promise<void>
  /** Jump to the home preset (0 on most cameras). */
  readonly goHome: () => Promise<void>
  /** Which preset `goHome` targets and who decided; `null` until loaded. */
  readonly homePreset: PTZHomePreset | null
  /** Pin the home preset. `null` clears the operator's choice. */
  readonly setHomePreset: (presetId: string | null) => Promise<void>
  /**
   * Make where the head is pointing RIGHT NOW this camera's home. The natural
   * gesture — aim, then say "here" — and the only one a camera whose home is
   * not a preset can accept.
   */
  readonly captureHomeHere: () => Promise<void>
  /**
   * Whether the camera returns home by itself when left idle, and after how
   * long. `null` = it has no such behaviour. The two are ONE fact on the
   * camera and are read and written together.
   */
  readonly homeReturn: PTZHomeReturn | null
  readonly setHomeReturn: (enabled: boolean, seconds: number) => Promise<void>
  /** Jump to a named preset. */
  readonly goToPreset: (presetId: string) => Promise<void>
  /**
   * Save the camera's current position as a new preset. Picks the
   * lowest unused numeric slot id, then refreshes the presets list.
   * Resolves to the created preset id, or `undefined` on failure.
   */
  readonly savePreset: (name: string) => Promise<string | undefined>
  /**
   * Overwrite an EXISTING preset with the camera's current position, keeping
   * its id and name. Provider-agnostic: reuses the real id the camera reported
   * (via `getPtzPresets`), so it works regardless of the vendor's slot scheme.
   */
  readonly updatePreset: (presetId: string) => Promise<void>
  /** Delete a preset by id, then refresh the presets list. */
  readonly deletePreset: (presetId: string) => Promise<void>
  /** List of presets reported by the camera. Empty until first refresh. */
  readonly presets: readonly PTZPreset[]
  /** Force a refresh of the presets list. */
  readonly refreshPresets: () => Promise<void>
  /**
   * Per-camera PTZ availability descriptor, or null until the first
   * `getOptions` refresh resolves (or on cameras without the cap).
   */
  readonly options: PTZOptions | null
  /** True while a control call is in flight (any path). */
  readonly busy: boolean
  /** Last error message from any cap call, or null. */
  readonly error: string | null
}

export function usePTZ(
  trpc: UseDeviceProxyTrpc,
  deviceId: number,
  hookOptions?: UsePTZOptions,
): UsePTZResult {
  const defaultSpeed = hookOptions?.defaultSpeed ?? 0.5
  const pulseMs = hookOptions?.pulseMs ?? 250
  const enabled = hookOptions?.enabled ?? true

  const dev = useDeviceProxy(trpc, enabled ? deviceId : null)
  const ptz = dev?.ptz

  const [presets, setPresets] = useState<readonly PTZPreset[]>([])
  const [homePreset, setHomePresetState] = useState<PTZHomePreset | null>(null)
  const [homeReturn, setHomeReturnState] = useState<PTZHomeReturn | null>(null)
  const [options, setOptions] = useState<PTZOptions | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshPresets = useCallback(async () => {
    if (!enabled || !ptz) return
    try {
      const list = await ptz.getPresets({})
      setPresets(list)
    } catch (err) {
      if (isAbsentProvider(err)) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [ptz, enabled])

  const refreshHomePreset = useCallback(async () => {
    if (!enabled || !ptz) return
    try {
      setHomePresetState(await ptz.getHomePreset({}))
    } catch (err) {
      if (isAbsentProvider(err)) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [ptz, enabled])

  const refreshHomeReturn = useCallback(async () => {
    if (!enabled || !ptz) return
    try {
      setHomeReturnState(await ptz.getHomeReturn({}))
    } catch (err) {
      if (isAbsentProvider(err)) return
      // A camera without the timer throws; that is "no such control", not an
      // error worth shouting at the operator.
      setHomeReturnState(null)
    }
  }, [ptz, enabled])

  const refreshOptions = useCallback(async () => {
    if (!enabled || !ptz) return
    try {
      const opts = await ptz.getOptions({})
      setOptions(opts)
    } catch (err) {
      if (isAbsentProvider(err)) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [ptz, enabled])

  useEffect(() => {
    void refreshPresets()
    void refreshOptions()
    void refreshHomePreset()
    void refreshHomeReturn()
  }, [refreshPresets, refreshOptions, refreshHomePreset, refreshHomeReturn])

  const wrap = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      if (!enabled || !ptz) return undefined
      setError(null)
      setBusy(true)
      try {
        return await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return undefined
      } finally {
        setBusy(false)
      }
    },
    [enabled, ptz],
  )

  const move = useCallback(
    async (direction: PTZDirection, speed?: number) => {
      if (!ptz) return
      const v = DIRECTION_VECTORS[direction]
      const s = speed ?? defaultSpeed
      await wrap(async () => {
        await ptz.move({ pan: v.pan, tilt: v.tilt, speed: s })
        // Pulse: stop after `pulseMs` so the camera doesn't keep gliding.
        await new Promise((r) => setTimeout(r, pulseMs))
        await ptz.stop({})
      })
    },
    [ptz, defaultSpeed, pulseMs, wrap],
  )

  const startContinuous = useCallback(
    async (direction: PTZDirection, speed?: number) => {
      if (!ptz) return
      const v = DIRECTION_VECTORS[direction]
      const s = speed ?? defaultSpeed
      await wrap(() => ptz.continuousMove({ pan: v.pan, tilt: v.tilt, speed: s }))
    },
    [ptz, defaultSpeed, wrap],
  )

  const stopContinuous = useCallback(async () => {
    if (!ptz) return
    await wrap(() => ptz.stop({}))
  }, [ptz, wrap])

  const zoom = useCallback(
    async (direction: 'in' | 'out', speed?: number) => {
      if (!ptz) return
      const z = direction === 'in' ? 1 : -1
      const s = speed ?? defaultSpeed
      await wrap(async () => {
        await ptz.move({ zoom: z, speed: s })
        await new Promise((r) => setTimeout(r, pulseMs))
        await ptz.stop({})
      })
    },
    [ptz, defaultSpeed, pulseMs, wrap],
  )

  const goHome = useCallback(async () => {
    if (!ptz) return
    await wrap(() => ptz.goHome({}))
  }, [ptz, wrap])

  const setHomePreset = useCallback(
    async (presetId: string | null) => {
      if (!ptz) return
      await wrap(() => ptz.setHomePreset({ presetId }))
      await refreshHomePreset()
    },
    [ptz, wrap, refreshHomePreset],
  )

  const captureHomeHere = useCallback(async () => {
    if (!ptz) return
    await wrap(() => ptz.captureHomeHere({}))
    await refreshHomePreset()
  }, [ptz, wrap, refreshHomePreset])

  const setHomeReturn = useCallback(
    async (enabled: boolean, seconds: number) => {
      if (!ptz) return
      await wrap(() => ptz.setHomeReturn({ enabled, seconds }))
      await refreshHomeReturn()
    },
    [ptz, wrap, refreshHomeReturn],
  )

  const goToPreset = useCallback(
    async (presetId: string) => {
      if (!ptz) return
      await wrap(() => ptz.goToPreset({ presetId }))
    },
    [ptz, wrap],
  )

  const savePreset = useCallback(
    async (name: string): Promise<string | undefined> => {
      if (!ptz) return undefined
      return wrap(async () => {
        // Camera preset slots are numbered; pick the lowest unused id so
        // we never collide with an occupied slot. Non-numeric ids (rare)
        // are ignored when scanning for the next free index.
        const usedIds = new Set(
          presets.map((p) => Number(p.id)).filter((n) => Number.isInteger(n) && n >= 0),
        )
        let nextId = 0
        while (usedIds.has(nextId)) nextId += 1
        const presetId = String(nextId)
        await ptz.savePreset({ presetId, name })
        await refreshPresets()
        return presetId
      })
    },
    [ptz, presets, refreshPresets, wrap],
  )

  const updatePreset = useCallback(
    async (presetId: string): Promise<void> => {
      if (!ptz) return
      await wrap(async () => {
        // Overwrite the existing slot: re-issue savePreset with the SAME id the
        // camera already reported, preserving its name. The provider re-points
        // that slot at the current position instead of allocating a new one.
        const existing = presets.find((p) => p.id === presetId)
        await ptz.savePreset({ presetId, name: existing?.name ?? '' })
        await refreshPresets()
      })
    },
    [ptz, presets, refreshPresets, wrap],
  )

  const deletePreset = useCallback(
    async (presetId: string) => {
      if (!ptz) return
      await wrap(async () => {
        await ptz.deletePreset({ presetId })
        await refreshPresets()
      })
    },
    [ptz, refreshPresets, wrap],
  )

  return {
    move,
    startContinuous,
    stopContinuous,
    zoom,
    goHome,
    homePreset,
    setHomePreset,
    captureHomeHere,
    homeReturn,
    setHomeReturn,
    goToPreset,
    savePreset,
    updatePreset,
    deletePreset,
    presets,
    refreshPresets,
    options,
    busy,
    error,
  }
}
