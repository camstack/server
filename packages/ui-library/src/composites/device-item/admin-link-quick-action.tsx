/**
 * <AdminLinkQuickAction> — the row-level "open this device's own config page"
 * affordance.
 *
 * ## Discreet, in this row's vocabulary
 *
 * The trailing run of a device row already carries a type-specific inline
 * control (a switch, a cover triad, a climate stepper, a sensor value), an
 * on-motion toggle, a PTZ button, a reboot button, whatever the caller injects
 * through `renderRowAction`, a delete button in table view and a status dot.
 * Anything added there competes with a control the operator uses daily, and
 * this one he uses roughly never.
 *
 * So it is the quietest thing the row can hold: a bare 12px glyph in
 * `text-foreground-subtle`, no chrome, no label, no colour until hover — a
 * step below `RebootQuickAction`, which at least has a hover surface, and it
 * sits LAST among the actions so it never displaces one. It renders as an `<a>`
 * rather than a button so the browser's own middle-click / copy-link /
 * open-in-new-tab all work, which is most of what an operator wants from it.
 *
 * ## It draws nothing rather than something dead
 *
 * Four gates, all of which draw nothing:
 *
 *  - the device proxy has not resolved, or the cap is not bound (the provider
 *    cannot answer for this device at all — a cloud-only vacuum, a Wyze cam);
 *  - the query has not answered yet, or failed (a non-admin session loses it,
 *    which is the intended outcome — no button beats a button that 403s);
 *  - the provider answered `null` (this device HAS no page);
 *  - the link is the DEVICE's own page and the device is offline — a web server
 *    on a camera that is not answering will not answer a browser either.
 *
 * That last gate is why `target` exists on the payload: an `integration` link
 * (the Home Assistant device page, the UniFi controller) stays put when the
 * device is offline, because the page is served by something else entirely and
 * is very often exactly where the operator wants to go when a device drops.
 *
 * D62's rule holds from the other side: nothing here renders a DISABLED button.
 * A greyed-out link would say "broken", and none of these four states is.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import type { DeviceAdminLink, DeviceProxy } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'

export interface AdminLinkQuickActionProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number
  /** Extra classes for the anchor — the detail header uses a larger glyph. */
  readonly className?: string
  /** Glyph size. The row wants 12px; the header wants 14px. */
  readonly iconClassName?: string
}

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

export function AdminLinkQuickAction({
  trpc,
  deviceId,
  className,
  iconClassName,
}: AdminLinkQuickActionProps): ReactNode {
  const t = useUiText()
  const link = useDeviceAdminLink(trpc, deviceId)
  if (link === null) return null

  return (
    <a
      href={link.url}
      target="_blank"
      // `noopener` is not optional on a target=_blank link to an address the
      // operator's own LAN serves: without it the opened page holds a live
      // `window.opener` handle back into the admin UI.
      rel="noopener noreferrer"
      onClick={(e) => {
        // The row navigates to the device detail on click. Without this the
        // operator gets the page AND a navigation he did not ask for.
        e.stopPropagation()
      }}
      className={cn(
        'inline-flex items-center justify-center rounded text-foreground-subtle hover:text-foreground transition-colors flex-shrink-0',
        className,
      )}
      title={`${link.label} — ${link.host}`}
      aria-label={t('uiLibrary.adminLinkQuickAction.open', 'Open {{label}} for this device', {
        label: link.label,
      })}
    >
      <ExternalLink className={cn('h-3 w-3', iconClassName)} />
    </a>
  )
}
