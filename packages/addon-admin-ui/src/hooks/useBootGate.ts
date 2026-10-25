/**
 * The admin shell's boot gate — what the React tree is allowed to wait for.
 *
 * ## What the gate is for
 *
 * Nothing may query before the socket has agreed on an identity. A query that
 * lands in the window between "WS open" and "addon services registered
 * server-side" comes back empty or errored, and React Query caches that answer.
 * `System.awaitConnected()` is exactly that agreement: one `auth.me` against the
 * live client, idempotent, bounded.
 *
 * ## What the gate is NOT for
 *
 * It used to await `system.init()`, which is `awaitConnected()` PLUS
 * `SystemMirror.init()` — three whole-fleet round-trips
 * (`getAllBindings` + `getAllSnapshots` + `deviceManager.listAll`). On the
 * reference hub, 1 019 devices: `listAll` alone answers in 5.6 s against
 * `/health` at 0.18 s. That was seconds of blank splash on every boot, spent
 * filling a cache the admin tree does not read — the admin UI takes its devices
 * from React Query (`useDeviceManagerListAll`, `hooks/useDevice.ts`), and
 * `System.getDeviceInfo` / `listDeviceInfos` / `listDevices` have no admin-UI
 * consumer at all.
 *
 * So the mirror is still warmed on boot — the REPL terminal reads it, and a
 * future consumer will — but off the critical path. A mirror that fails is a
 * cold cache, not a broken app, and it is not reported as a boot error: nothing
 * the operator can see is missing because of it.
 *
 * The narrowing that is NOT done here: `SystemMirror.init` keeps the FULL
 * projection. `refreshDeviceMetadata` re-seeds the same map from
 * `deviceManager.getDevice`, which has no projection parameter and always
 * answers full — a slim warm-boot would make the map heterogeneous, so
 * `sm.dump(id)` in the REPL would show `config: {}` for a device that had not
 * changed and the real config for one that had. Deferring the whole warm-boot
 * beats shrinking one of its three legs, and it changes no shape.
 */
import { useEffect, useState } from 'react'

/**
 * The two `System` entry points the gate uses. A structural subset, so a test
 * supplies the two functions and nothing else.
 */
export interface BootGateSystem {
  /** Transport probe — `auth.me`. This is what the gate waits for. */
  awaitConnected(timeoutMs?: number): Promise<void>
  /** Device-mirror warm-boot. Started, never awaited. */
  init(timeoutMs?: number): Promise<void>
}

/** Presence is all the gate reads; the shape is the auth context's user. */
export interface BootGatePrincipal {
  readonly username: string
}

export interface BootGateState {
  /** True once children may mount. */
  readonly bootReady: boolean
  /** Probe failure text for the non-blocking banner, or `null`. */
  readonly bootError: string | null
}

/** tRPC surfaces the auth outcome as `error.data.code`. */
interface TrpcErrorLike {
  readonly data?: { readonly code?: string }
}

function errorCodeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const { data } = err as TrpcErrorLike
  return data?.code
}

function isAuthFailure(err: unknown, message: string): boolean {
  const code = errorCodeOf(err)
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return true
  return /UNAUTHORIZED|FORBIDDEN/.test(message)
}

/**
 * Gate the tree on the transport probe. Re-arms whenever `system` changes (a
 * fresh `System` is built on auth-user change). Watchdog reconnect calls
 * `System.reconnect()` on the same instance so this effect does not re-arm
 * and open dialogs are not torn down by BootSplash.
 */
export function useBootGate(
  system: BootGateSystem,
  user: BootGatePrincipal | null,
  logout: () => void,
  /**
   * Refresh the session and re-handshake the socket; `true` = alive, probe
   * again. Without it (or when it returns `false`) an auth failure logs out.
   */
  recover?: () => Promise<boolean>,
): BootGateState {
  const [bootReady, setBootReady] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    setBootReady(false)
    setBootError(null)
    if (!user) {
      // No authenticated user → the unprotected routes (login, access-denied)
      // must render. There is no session to probe.
      setBootReady(true)
      return undefined
    }
    let cancelled = false

    // Warm the device mirror alongside the probe, never in front of it.
    // `System.init` awaits `awaitConnected` internally, so this does not race
    // the handshake; the rejection is absorbed because no rendered surface
    // reads the mirror.
    void system.init().catch(() => undefined)

    const probe = (mayRecover: boolean): void => {
      system.awaitConnected().then(
        () => {
          if (!cancelled) setBootReady(true)
        },
        (err: unknown) => {
          if (cancelled) return
          const msg = err instanceof Error ? err.message : String(err)
          // UNAUTHORIZED is not yet a sign-out: a socket handshaken with a
          // stale token fails the same way as a revoked session. Refresh once
          // and probe again; only a refused refresh (or no recovery) logs out.
          if (isAuthFailure(err, msg)) {
            if (mayRecover && recover !== undefined) {
              recover().then(
                (alive) => {
                  if (cancelled) return
                  if (alive) {
                    probe(false)
                    return
                  }
                  console.warn('[boot-gate] logout: probe UNAUTHORIZED and the refresh was refused')
                  logout()
                },
                () => {
                  if (cancelled) return
                  console.warn('[boot-gate] logout: probe UNAUTHORIZED and recovery failed')
                  logout()
                },
              )
              return
            }
            console.warn('[boot-gate] logout: probe UNAUTHORIZED after a successful refresh', msg)
            logout()
            return
          }
          // Other (e.g. transient network) failures: surface but still unblock
          // the tree — the route-level loading states keep retrying.
          setBootError(msg)
          setBootReady(true)
        },
      )
    }
    probe(true)

    return () => {
      cancelled = true
    }
  }, [system, user, logout, recover])

  return { bootReady, bootError }
}
