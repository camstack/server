/**
 * ReconnectOverlay — restart-completion toaster. Tracks
 * `BackendConnectionState` via `system.subscribeConnectionEvents` and,
 * after a reconnect, queries `addons.getLastRestart` once and (if the
 * response is non-null and recent) appends a success toast describing
 * the framework/manual update that triggered the cycle.
 *
 * It no longer renders a blocking full-screen overlay while
 * disconnected — the `AppLayout` top banner already signals "Server
 * unreachable", and a full-screen blocker trapped the operator on
 * whatever page they were on (the hub reboots frequently in dev under
 * tsx-watch). The name is kept for import stability; the component is
 * now toast-only.
 *
 * Spec: docs/superpowers/specs/2026-05-14-framework-live-update-design.md
 *
 * The `getLastRestart` cap method retains the most-recent marker
 * server-side for 5 minutes after boot, so a slow client reconnect
 * (browser tab woken from sleep, network blip) still surfaces the
 * toast.
 */
import { CheckCircle2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSystem, useAddonsGetLastRestart } from '@camstack/ui-library'
import i18n from '../../i18n/index'

type ConnState = 'connected' | 'disconnected' | 'connecting'

interface CompletionToast {
  readonly id: string
  readonly title: string
  readonly message: string
}

export function ReconnectOverlay() {
  const system = useSystem()
  const queryClient = useQueryClient()
  const [state, setState] = useState<ConnState>(() =>
    system.isConnected() ? 'connected' : 'disconnected',
  )

  // Sticky flag — true once we've observed any disconnect this session.
  // Suppresses the "no restart toast on initial connect" flicker.
  const sawDisconnectRef = useRef(false)
  // Bumps on every fresh reconnect so the lastRestart query re-runs.
  const [reconnectTick, setReconnectTick] = useState(0)
  const [toasts, setToasts] = useState<readonly CompletionToast[]>([])

  useEffect(() => {
    const unsub = system.subscribeConnectionEvents((next) => {
      setState((prev) => {
        if (prev !== 'connected' && next === 'connected') {
          if (sawDisconnectRef.current) {
            setReconnectTick((t) => t + 1)
          }
        }
        if (next !== 'connected') sawDisconnectRef.current = true
        return next
      })
    })
    return unsub
  }, [system])

  // Invalidate the cached last-restart query on every fresh reconnect so
  // useAddonsGetLastRestart re-fetches against the new server process.
  // Without this the React-Query cache would serve the previous boot's
  // null/stale response forever.
  useEffect(() => {
    if (reconnectTick === 0) return
    void queryClient.invalidateQueries({ queryKey: [['addons', 'getLastRestart']] })
  }, [reconnectTick, queryClient])

  // Query the cached last-restart on every fresh reconnect. `enabled`
  // is gated on (connected && reconnectTick > 0) so the initial mount
  // doesn't fetch — only post-disconnect events trigger the toast.
  const { data: lastRestart } = useAddonsGetLastRestart(undefined, {
    enabled: state === 'connected' && reconnectTick > 0,
    staleTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  })

  // Append a toast the first time we observe a non-null `getLastRestart`
  // payload after a reconnect. Same-payload re-renders are deduped via
  // the `requestedAt` timestamp.
  const lastToastedRequestedAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (lastRestart === null || lastRestart === undefined) return
    if (lastRestart.requestedAt === lastToastedRequestedAtRef.current) return
    lastToastedRequestedAtRef.current = lastRestart.requestedAt

    const toast = buildToastForMarker(lastRestart)
    setToasts((prev) => [...prev, toast])

    const timer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== toast.id))
    }, 6000)
    return () => window.clearTimeout(timer)
  }, [lastRestart])

  // `state` is intentionally not rendered — the AppLayout banner owns
  // the disconnected affordance. This component only emits the
  // post-reconnect restart-completion toasts.
  return <>{toasts.length > 0 && <ToastStack toasts={toasts} />}</>
}

// ---------------------------------------------------------------------------
// Local toast stack (separate from ToastContainer so we don't depend on
// the server-broadcast `toast.onToast` channel — restart-completed has
// to render before the toast subscription re-establishes).
// ---------------------------------------------------------------------------

function ToastStack({ toasts }: { toasts: readonly CompletionToast[] }) {
  return (
    // Safe-area offsets are NOT optional here. `position: fixed` resolves
    // against the VIEWPORT, so it bypasses the `env(safe-area-inset-*)`
    // padding AppLayout puts on the app shell — and this component is
    // mounted outside AppLayout anyway. Under `viewport-fit=cover` (set in
    // index.html) plus `apple-mobile-web-app-status-bar-style:
    // black-translucent`, the viewport starts at y=0 BEHIND the notch, so a
    // plain `top-4` landed this toast on top of the iOS clock. `calc(env(…)
    // + 1rem)` collapses to exactly the old `1rem` on non-notched devices.
    <div className="fixed top-[calc(env(safe-area-inset-top)+1rem)] right-[calc(env(safe-area-inset-right)+1rem)] z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start gap-2 px-3 py-2.5 rounded-md border border-green-500/30 bg-green-500/10 shadow-lg backdrop-blur-sm"
        >
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-green-400" />
          <div>
            <div className="text-[11px] font-semibold text-foreground">{t.title}</div>
            <div className="text-[10px] text-foreground-subtle mt-0.5">{t.message}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toast formatting
// ---------------------------------------------------------------------------

interface LastRestartShape {
  readonly kind: 'framework-update' | 'manual' | 'system' | 'framework-bulk-update'
  readonly packageName?: string
  readonly fromVersion?: string
  readonly toVersion?: string
  readonly requestedBy?: string
  readonly requestedAt: number
}

function buildToastForMarker(marker: LastRestartShape): CompletionToast {
  const id = `restart-${marker.requestedAt}`

  if (
    marker.kind === 'framework-update' &&
    marker.packageName !== undefined &&
    marker.toVersion !== undefined
  ) {
    const fromTo =
      marker.fromVersion !== undefined
        ? `v${marker.fromVersion} → v${marker.toVersion}`
        : `v${marker.toVersion}`
    return {
      id,
      title: i18n.t('system.reconnectOverlay.frameworkUpdated', 'Framework updated'),
      message: i18n.t('system.reconnectOverlay.isNow', '{{packageName}} is now {{fromTo}}.', {
        packageName: marker.packageName,
        fromTo,
      }),
    }
  }

  return {
    id,
    title: i18n.t('system.reconnectOverlay.serverRestarted', 'Server restarted'),
    message:
      marker.requestedBy !== undefined
        ? i18n.t(
            'system.reconnectOverlay.manualRestartByCompleted',
            'Manual restart by {{requestedBy}} completed.',
            { requestedBy: marker.requestedBy },
          )
        : i18n.t('system.reconnectOverlay.manualRestartCompleted', 'Manual restart completed.'),
  }
}
