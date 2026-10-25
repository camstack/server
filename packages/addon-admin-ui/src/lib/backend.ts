/**
 * Singleton accessor for the unified `System` SDK instance.
 *
 * `System` is the canonical client-side entry point for the admin UI.
 * `<App>` wires the singleton into both `<SystemProvider>` (so React
 * hooks like `useSystem()`, `useDevices()`, `useDevice(id)` and the
 * codegen'd `use<Cap><Method>()` resolve at render time) and
 * `<trpc.Provider>` (so the existing React-Query proxy reuses the same
 * WebSocket).
 *
 * This module is React-agnostic — it is the boot-time wiring used by
 * the admin shell to construct + dispose the singleton. React-side
 * consumers should always go through `useSystem()`.
 */
import { createSystem, type System } from '@camstack/sdk'
import i18n from '../i18n'
import { sessionKeeper } from './admin-session'
import { reportSdkConnectionState } from './connection-health'
import { hubOrigin } from './mount'

let instance: System | null = null
let instanceGeneration = 0

export function getSystem(): System {
  if (!instance) {
    const generation = instanceGeneration
    const serverUrl = hubOrigin()
    const token = localStorage.getItem('camstack_admin_token') ?? undefined
    instance = createSystem({
      serverUrl,
      token,
      // The admin's current language on every request (D863): the hub answers
      // schema labels and error messages in it.
      getLanguage: () => i18n.language,
      // A socket handshake never carries a token the hub refuses: the keeper
      // refreshes it over HTTP first (an expired token), or at once when the
      // hub closed the last socket with 4401 (a revoked one). A refusal
      // signs the user out through the keeper's `onExpired`.
      refreshCredential: async (reason) => {
        if (reason === 'rejected') await sessionKeeper().refreshNow()
        else await sessionKeeper().ensureFresh()
      },
      // Single observer for connection-state transitions. The SDK
      // emits `'connected' | 'disconnected' | 'connecting'` here, so
      // we don't need separate `onOpen` / `onClose` wiring — the
      // unified callback covers both plus the manual-reconnect case.
      // The connection-health store verifies hub liveness with a
      // hub-only probe before classifying a WS drop, so a slow /
      // degraded cluster node is not misreported as "Server
      // unreachable" (see lib/connection-health.ts).
      // A closed System can deliver its final `onClose` asynchronously after
      // its replacement has already opened. Ignore callbacks from retired
      // generations so an old socket cannot leave the global banner stuck in
      // "live connection interrupted" while the active socket is healthy.
      onConnectionChange: (state) => {
        if (generation === instanceGeneration) reportSdkConnectionState(state)
      },
    })
    // NOTE: `init()` is intentionally NOT fired here. AppShell owns
    // the boot-readiness gate (see `App.tsx`) and drives `init()` so
    // the React tree only mounts children once the transport probe
    // + mirror warm-boot have succeeded. Firing init from this
    // module ran in parallel with the tree mounting → queries raced
    // against the WS handshake → cached empty/error responses (the
    // class of bug 5d784beb / 13574a05 worked around defensively).
  }
  return instance
}

export function resetSystem(): void {
  const retired = instance
  instance = null
  instanceGeneration += 1
  retired?.close()
}
