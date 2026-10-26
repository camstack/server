import { useState } from 'react'
import { Cctv, Server, Radio, Home, Wifi } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAddonIconUrl } from '../../contexts/addon-icons-context'

// i18n-ignore-start: vendor and protocol names are brand names, never translated
const PROVIDERS: Record<string, { icon: LucideIcon; color: string; label: string }> = {
  amcrest: { icon: Cctv, color: '#3b82f6', label: 'Amcrest' },
  hikvision: { icon: Server, color: '#a855f7', label: 'Hikvision' },
  reolink: { icon: Radio, color: '#06b6d4', label: 'Reolink' },
  homeassistant: { icon: Home, color: '#22d3ee', label: 'Home Assistant' },
  rtsp: { icon: Wifi, color: '#78716c', label: 'RTSP' },
  onvif: { icon: Wifi, color: '#78716c', label: 'ONVIF' },
}
// i18n-ignore-end

interface ProviderIconProps {
  type: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  showLabel?: boolean
}

const SIZES = { sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6', xl: 'h-16 w-16' }
const CONTAINER_SIZES = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
  lg: 'h-10 w-10',
  xl: 'h-16 w-16',
}

/**
 * Resolve a free-form provider hint to a registry key. Devices and
 * integrations expose `addonId` (e.g. `'provider-reolink'`,
 * `'provider-hikvision'`) where the icon registry is keyed by the bare
 * provider name. We strip the `provider-` prefix before lookup, then
 * return the lower-cased type as the canonical key (or `null` when
 * the hint doesn't map to a known provider).
 */
function normalizeProviderKey(type: string): string {
  const lower = type.toLowerCase()
  if (lower.startsWith('provider-')) return lower.slice('provider-'.length)
  return lower
}

function lookupProvider(type: string): { icon: LucideIcon; color: string; label: string } {
  const key = normalizeProviderKey(type)
  return PROVIDERS[key] ?? { icon: Cctv, color: '#78716c', label: type }
}

export function ProviderIcon({ type, size = 'md', showLabel }: ProviderIconProps) {
  const provider = lookupProvider(type)
  const Icon = provider.icon
  // The addon's own icon — but only one its manifest DECLARES. `type` is
  // usually the owning addon's id (`provider-reolink`, `core-blocks`,
  // `camera-grid`); a bare provider name resolves to `provider-<name>`
  // only when that addon is known. Never a guessed URL: prefixing every
  // id with `provider-` used to request `provider-core-blocks/...` and 404.
  const [iconBroken, setIconBroken] = useState(false)
  const assetUrl = useAddonIconUrl(type)

  return (
    <div className="flex items-center gap-2">
      <div
        className={`flex items-center justify-center rounded-lg ${CONTAINER_SIZES[size]}`}
        style={{ backgroundColor: `${provider.color}15` }}
      >
        {iconBroken || !assetUrl ? (
          <Icon className={SIZES[size]} style={{ color: provider.color }} />
        ) : (
          <img
            src={assetUrl}
            alt={provider.label}
            className={SIZES[size]}
            onError={() => setIconBroken(true)}
          />
        )}
      </div>
      {showLabel && (
        <span className="text-xs font-medium text-foreground-subtle">{provider.label}</span>
      )}
    </div>
  )
}

export function getProviderColor(type: string): string {
  return lookupProvider(type).color
}

export function getProviderLabel(type: string): string {
  return lookupProvider(type).label
}
