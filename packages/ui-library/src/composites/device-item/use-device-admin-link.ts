/**
 * `useDeviceAdminLink` — the one decision on whether a device has its own
 * config page, shared by the device-page header button, the Web interface card
 * and the gateway card.
 *
 * It resolves nothing rather than something dead, in four cases:
 *
 *  - the device proxy has not resolved, or the cap is not bound (the provider
 *    cannot answer for this device at all — a cloud-only vacuum, a Wyze cam);
 *  - the query has not answered yet, or failed (a non-admin session loses it,
 *    which is the intended outcome — no button beats a button that 403s);
 *  - the provider answered `null` (this device HAS no page);
 *  - the link is the DEVICE's own page and the device is offline — a web server
 *    on a camera that is not answering will not answer a browser either. An
 *    `integration` link (the Home Assistant device page, the UniFi controller)
 *    stays put when the device is offline.
 *
 * D62's rule holds from the other side: nothing here renders a DISABLED button.
 */
import { useEffect, useState } from 'react'
import type { DeviceAdminLink, DeviceProxy } from '@dominevo/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'

/**
 * The four answers this hook can give. `pending` and `failed` are DISTINCT
 * from `none` although every one of them draws nothing today — collapsing them
 * into a boolean is how "not yet known" becomes "not installed" (D315), and the
 * first surface that wants to say "checking…" would otherwise have to re-derive
 * the difference from scratch.
 */
type AdminLinkState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'none' }
  | { readonly kind: 'link'; readonly link: DeviceAdminLink }

/**
 * Resolve the link, or null, applying every gate. Split out so the row button
 * and the detail-header button share ONE decision — two copies of a four-state
 * gate is how the two surfaces end up disagreeing about the same device.
 *
 * Asked through the DEVICE PROXY (`cap.getAdminLink`), not through the
 * generated tRPC hook. The generated hook reads ui-library's own tRPC react
 * context, which the device row does not have and must not require: the row
 * takes its `trpc` as a PROP precisely so a caller can render it against a
 * different client. Wiring the generated hook in here turned 120 existing
 * device-item tests red with "Unable to find tRPC Context" — and would have
 * done the same to any embedding that does not sit under ui-library's provider.
 *
 * One read per (device, binding). The answer is a configured address: it
 * changes when an operator edits a connection, which respawns the runner and
 * re-resolves the proxy anyway.
 */
export function useDeviceAdminLink(
  trpc: UseDeviceProxyTrpc,
  deviceId: number,
): DeviceAdminLink | null {
  const { dev, cap, online } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d: DeviceProxy) => d.deviceAdminLink,
    slice: () => undefined,
  })
  // Cap handle alone is not enough — createDeviceProxy used to always expose
  // every device-scoped interface; gate on the binding entry so unbound
  // devices (composer, script, …) never dial getAdminLink.
  const capBound =
    dev !== null &&
    cap !== undefined &&
    cap !== null &&
    (dev.binding?.entries.some((e) => e.capName === 'device-admin-link') ??
      // When binding is absent on the proxy, fall back to the optional handle
      // (post-codegen factory already omits unbound caps).
      true)
  const [state, setState] = useState<AdminLinkState>({ kind: 'pending' })

  useEffect(() => {
    if (!capBound || cap === undefined || cap === null) {
      setState({ kind: 'none' })
      return
    }
    let live = true
    // try/catch around the CALL, not only `.catch` on the promise: a proxy
    // handle that is not wired for this cap throws SYNCHRONOUSLY, and an
    // uncaught throw inside a layout effect unmounts the whole row. It did —
    // five device-row tests went red on a stub proxy before this was here.
    try {
      void cap
        .getAdminLink({})
        .then((link) => {
          if (!live) return
          setState(link === null || link === undefined ? { kind: 'none' } : { kind: 'link', link })
        })
        .catch(() => {
          // A caller without the right loses the call. Drawing nothing is the
          // intended outcome — no button beats a button that 403s on click.
          if (live) setState({ kind: 'failed' })
        })
    } catch {
      setState({ kind: 'failed' })
    }
    return () => {
      live = false
    }
  }, [capBound, cap, deviceId])

  if (state.kind !== 'link') return null
  if (state.link.target === 'device' && !online) return null
  return state.link
}
