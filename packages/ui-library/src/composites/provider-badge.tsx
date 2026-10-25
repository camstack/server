import { cn } from '../lib/cn'
import type { ProviderType } from '../icons'
import { type JSX } from 'react'

export interface ProviderBadgeProps {
  provider: ProviderType
  showLabel?: boolean
  className?: string
}

// i18n-ignore-start: vendor names are brand names, never translated
const providerConfig: Record<ProviderType, { colorClass: string; label: string }> = {
  onvif: { colorClass: 'bg-provider-onvif', label: 'ONVIF' },
  hikvision: { colorClass: 'bg-provider-hikvision', label: 'Hikvision' },
  reolink: { colorClass: 'bg-provider-reolink', label: 'Reolink' },
  homeAssistant: { colorClass: 'bg-provider-homeAssistant', label: 'Home Assistant' },
  rtsp: { colorClass: 'bg-provider-rtsp', label: 'RTSP' },
}
// i18n-ignore-end

export function ProviderBadge({
  provider,
  showLabel = true,
  className,
}: ProviderBadgeProps): JSX.Element {
  const config = providerConfig[provider]

  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)}>
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-sm', config.colorClass)}
        aria-hidden="true"
      />
      {showLabel && <span className="text-foreground">{config.label}</span>}
    </span>
  )
}
