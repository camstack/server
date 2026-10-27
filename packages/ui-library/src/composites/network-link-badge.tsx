/**
 * NetworkLinkBadge — compact link indicator for device rows and headers.
 *
 * A wire glyph for ethernet, a wifi glyph with the signal for wireless, an
 * antenna for cellular. Renders nothing for an `unknown` link — that is the
 * absence of a read, not a link — and shows no percentage when the signal is
 * `null` (a wire has none; a wireless link not yet read must not sit at 0 %).
 *
 * Self-contained on data: the caller passes the `network-link` slice from
 * `useDeviceNetworkLink` and drops the badge in unconditionally.
 */
import { Cable, RadioTower, Wifi, WifiHigh, WifiLow, WifiZero } from 'lucide-react'
import { cn } from '../lib/cn'
import { useUiText } from '../contexts/ui-text'
import { type JSX } from 'react'

export interface NetworkLinkStatusLike {
  readonly type: 'wifi' | 'ethernet' | 'cellular' | 'unknown'
  readonly signal: number | null
  readonly ssid?: string
}

export interface NetworkLinkBadgeProps {
  readonly status: NetworkLinkStatusLike | null | undefined
  readonly className?: string
}

/** Monotonic — more signal, more arcs. */
function pickWifiIcon(signalPercent: number | null): typeof Wifi {
  if (signalPercent === null) return Wifi
  if (signalPercent <= 20) return WifiZero
  if (signalPercent <= 50) return WifiLow
  if (signalPercent <= 80) return WifiHigh
  return Wifi
}

function signalColor(signalPercent: number | null): string {
  if (signalPercent === null) return 'text-foreground-subtle'
  if (signalPercent <= 20) return 'text-rose-400'
  if (signalPercent <= 50) return 'text-amber-400'
  return 'text-foreground-subtle'
}

export function NetworkLinkBadge({ status, className }: NetworkLinkBadgeProps): JSX.Element | null {
  const t = useUiText()
  if (!status || status.type === 'unknown') return null

  if (status.type === 'ethernet') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[10px] font-medium text-foreground-subtle',
          className,
        )}
        title={t('uiLibrary.networkLinkBadge.ethernet', 'Network: ethernet')}
      >
        <Cable className="h-3.5 w-3.5" />
      </span>
    )
  }

  const Icon = status.type === 'cellular' ? RadioTower : pickWifiIcon(status.signal)
  const signal = status.signal === null ? null : Math.round(status.signal)
  const networkText = status.ssid
    ? t('uiLibrary.networkLinkBadge.typeSsid', 'Network: {{type}} ({{ssid}})', {
        type: status.type,
        ssid: status.ssid,
      })
    : t('uiLibrary.networkLinkBadge.type', 'Network: {{type}}', { type: status.type })
  const title =
    signal === null
      ? networkText
      : `${networkText} · ${t('uiLibrary.networkLinkBadge.signal', 'signal {{percent}}%', { percent: signal })}`
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] font-medium',
        signalColor(status.signal),
        className,
      )}
      title={title}
    >
      <Icon className="h-3.5 w-3.5" />
      {signal !== null && <span>{signal}%</span>}
    </span>
  )
}
