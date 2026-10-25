/**
 * useNavigation — drive a `navigation` robot camera from the UI.
 *
 * The cap's `move` is MOMENTARY: fluid driving is the UI sending a nudge at
 * 1 Hz while a direction is held and ONE `stop` on release, exactly like the
 * robot app's joystick. This hook owns that cadence (`startDrive` /
 * `stopDrive`); the provider forwards each nudge to a single drive write.
 *
 * Everything else is a plain call plus the data the panel renders from:
 * `features` (which primitives are on), `actions` (the enabled dictionary)
 * and the live `status` slice off the device proxy.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  NavigationActionEntry,
  NavigationActionId,
  NavigationFeatures,
  NavigationLightMode,
  NavigationStatus,
} from '@camstack/types'
import { useDeviceProxy, useDeviceState, type UseDeviceProxyTrpc } from './use-device-proxy'

export type NavigationDirection = 'forward' | 'left' | 'right' | 'spin'

/** The cadence the robot app drives at while a direction is held. */
export const NAVIGATION_DRIVE_INTERVAL_MS = 1000

const DIRECTION_VECTORS: Record<NavigationDirection, { pan: number; tilt: number }> = {
  forward: { pan: 0, tilt: 1 },
  left: { pan: -1, tilt: 0 },
  right: { pan: 1, tilt: 0 },
  spin: { pan: 0, tilt: -1 },
}

export interface UseNavigationOptions {
  readonly enabled?: boolean
}

export interface UseNavigationResult {
  readonly features: NavigationFeatures | null
  readonly actions: readonly NavigationActionEntry[]
  readonly status: NavigationStatus | null
  /** Start nudging in a direction at 1 Hz until `stopDrive`. */
  readonly startDrive: (direction: NavigationDirection) => void
  readonly stopDrive: () => Promise<void>
  readonly runAction: (actionId: NavigationActionId) => Promise<void>
  readonly playSound: (soundId: number) => Promise<void>
  readonly setLightOn: (on: boolean) => Promise<void>
  readonly setLightMode: (mode: NavigationLightMode, level?: number) => Promise<void>
  readonly setLightLevel: (level: number) => Promise<void>
  readonly busy: boolean
  readonly error: string | null
  /** True while a direction is held. */
  readonly driving: NavigationDirection | null
}

function isAbsentProvider(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /not available|no provider|NOT_FOUND|PRECONDITION/i.test(message)
}

export function useNavigation(
  trpc: UseDeviceProxyTrpc,
  deviceId: number,
  hookOptions?: UseNavigationOptions,
): UseNavigationResult {
  const enabled = hookOptions?.enabled ?? true
  const dev = useDeviceProxy(trpc, enabled ? deviceId : null)
  const nav = dev?.navigation
  const status = useDeviceState(trpc, enabled ? deviceId : null, (s) => s.navigation)
  const [features, setFeatures] = useState<NavigationFeatures | null>(null)
  const [actions, setActions] = useState<readonly NavigationActionEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [driving, setDriving] = useState<NavigationDirection | null>(null)
  const driveTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!enabled || !nav) return
    let cancelled = false
    void (async () => {
      try {
        const [nextFeatures, nextActions] = await Promise.all([
          nav.getFeatures({}),
          nav.listActions({}),
        ])
        if (cancelled) return
        setFeatures(nextFeatures)
        setActions(nextActions)
      } catch (err) {
        if (cancelled || isAbsentProvider(err)) return
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [nav, enabled])

  const wrap = useCallback(
    async (fn: () => Promise<void>): Promise<void> => {
      if (!enabled || !nav) return
      setError(null)
      setBusy(true)
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [enabled, nav],
  )

  const clearTimer = useCallback(() => {
    if (driveTimer.current !== null) {
      clearInterval(driveTimer.current)
      driveTimer.current = null
    }
  }, [])

  const stopDrive = useCallback(async () => {
    clearTimer()
    setDriving(null)
    if (!nav) return
    await wrap(() => nav.stop({}))
  }, [clearTimer, nav, wrap])

  const startDrive = useCallback(
    (direction: NavigationDirection) => {
      if (!nav) return
      clearTimer()
      setDriving(direction)
      const vector = DIRECTION_VECTORS[direction]
      const nudge = (): void => {
        nav.move({ pan: vector.pan, tilt: vector.tilt }).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err))
        })
      }
      nudge()
      driveTimer.current = setInterval(nudge, NAVIGATION_DRIVE_INTERVAL_MS)
    },
    [clearTimer, nav],
  )

  // Never leave a robot driving because the panel unmounted mid-press.
  useEffect(() => {
    return () => {
      if (driveTimer.current !== null) {
        clearInterval(driveTimer.current)
        driveTimer.current = null
        nav?.stop({}).catch(() => undefined)
      }
    }
  }, [nav])

  const runAction = useCallback(
    (actionId: NavigationActionId) => wrap(async () => nav?.runAction({ actionId })),
    [nav, wrap],
  )
  const playSound = useCallback(
    (soundId: number) => wrap(async () => nav?.playSound({ soundId })),
    [nav, wrap],
  )
  const setLightOn = useCallback(
    (on: boolean) => wrap(async () => nav?.setLightOn({ on })),
    [nav, wrap],
  )
  const setLightMode = useCallback(
    (mode: NavigationLightMode, level?: number) =>
      wrap(async () => nav?.setLightMode(level === undefined ? { mode } : { mode, level })),
    [nav, wrap],
  )
  const setLightLevel = useCallback(
    (level: number) => wrap(async () => nav?.setLightLevel({ level })),
    [nav, wrap],
  )

  return {
    features,
    actions,
    status: (status as NavigationStatus | undefined) ?? null,
    startDrive,
    stopDrive,
    runAction,
    playSound,
    setLightOn,
    setLightMode,
    setLightLevel,
    busy,
    error,
    driving,
  }
}
