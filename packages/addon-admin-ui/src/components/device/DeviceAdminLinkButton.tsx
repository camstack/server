/**
 * <DeviceAdminLinkButton> — the device-detail header's "open this device's own
 * config page" action.
 *
 * Same answer as the row's `AdminLinkQuickAction`, from the SAME hook
 * (`useDeviceAdminLink`), deliberately: two surfaces that derived the gate
 * separately would sooner or later disagree about one device, and the operator
 * would be right to believe whichever one told him there was a page.
 *
 * What differs is only the presentation. The row's version is a bare 12px
 * glyph at the end of a run of controls the operator uses daily. Here there is
 * room and the action is one of a handful the header offers, so it takes the
 * same shape as the Enable/Disable button beside it — bordered pill, icon plus
 * a label that collapses to the icon on phones — and sits between the camera
 * function switches and the kebab, ahead of the kebab because it opens
 * something rather than hiding more choices.
 *
 * It renders nothing when there is no page, when the answer has not arrived,
 * when the caller is not entitled to ask, or when a DEVICE-hosted page belongs
 * to a device that is offline. Never a disabled button: none of those four is
 * "broken" (D62).
 */
import { useDeviceAdminLink, useSystem } from '@camstack/ui-library'
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'

export interface DeviceAdminLinkButtonProps {
  readonly deviceId: number
}

export function DeviceAdminLinkButton({ deviceId }: DeviceAdminLinkButtonProps): ReactNode {
  const system = useSystem()
  const link = useDeviceAdminLink(system.trpcClient, deviceId)
  if (link === null) return null

  return (
    <a
      href={link.url}
      target="_blank"
      // Without `noopener` the opened page keeps a live `window.opener` handle
      // back into the admin UI.
      rel="noopener noreferrer"
      title={`${link.label} — ${link.host}`}
      className="inline-flex items-center gap-1.5 rounded-lg px-2 sm:px-2.5 py-1.5 text-[11px] font-medium border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {/* Label hides on phones — the glyph carries it, as with Enable/Disable. */}
      <span className="hidden sm:inline">{link.label}</span>
    </a>
  )
}
