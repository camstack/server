import { ProviderIcon } from '../../shared/ProviderIcon'
import { StatusBadge } from '@camstack/ui-library'
import { CapabilityBadges } from '../../shared/CapabilityBadges'
import type { HeroProps } from './HeroRegistry'
import { useTranslation } from 'react-i18next'

/**
 * Fallback hero for device types with no specialised view (Hub /
 * Thermostat / Generic). Mirrors the previous in-page placeholder: an
 * identity card with provider icon, status, and the device's
 * capability badges. Heroes registered for known types in
 * `HeroRegistry` short-circuit before reaching this component.
 */
export function GenericHero({ deviceName, deviceType, provider, isOnline, features }: HeroProps) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface p-6 text-center">
      <ProviderIcon type={provider} size="lg" />
      <div>
        <div className="text-sm font-semibold text-foreground">{deviceName}</div>
        <div className="text-[10px] text-foreground-subtle uppercase tracking-wider mt-0.5">
          {deviceType}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap justify-center">
        <StatusBadge status={isOnline ? 'online' : 'offline'} />
        {features.length > 0 && <CapabilityBadges capabilities={features} />}
      </div>
      <div className="text-[10px] text-foreground-subtle italic max-w-xs mt-1">
        {t(
          'hero.genericHero.noLiveViewForThis',
          'No live view for this device type. Use the Config tab or the shortcut row to interact.',
        )}
      </div>
    </div>
  )
}
