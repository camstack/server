/**
 * The live hero card of one device: the hero-model module with the legacy
 * `DeviceHero` as its fallback. The device page and the quick-detail modal both
 * draw it (a camera is the device page's own stream panel, never this card), so
 * the two never describe a device differently.
 */
import { heroLang, useSystem, useThemeMode } from '@dominevo/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../../contexts/auth-context'
import { DeviceDetailModule } from '../../../modules/device-detail'
import { DeviceHero } from './HeroRegistry'

export interface DeviceHeroCardDevice {
  readonly type?: string
  readonly role?: string | null
  readonly addonId?: string
  readonly online?: boolean
  readonly features?: readonly string[]
}

export interface DeviceHeroCardProps {
  readonly deviceId: number
  readonly device: DeviceHeroCardDevice | null | undefined
  readonly deviceName: string
  readonly defaultHistoryOpen?: boolean
  /**
   * Draw the legacy per-type hero when the hero model draws nothing. The device
   * page does; the viewer's card and the quick-detail modal show the model alone.
   */
  readonly legacyFallback?: boolean
  readonly onDrawn?: (drawn: boolean) => void
  /**
   * Where every navigation the card starts goes (open device, open camera, a
   * deep link). Absent: the router. The modal passes its guarded leave, so a
   * dirty edit is confirmed first.
   */
  readonly onNavigate?: (path: string) => void
}

export function DeviceHeroCard({
  deviceId,
  device,
  deviceName,
  defaultHistoryOpen = false,
  legacyFallback = true,
  onDrawn,
  onNavigate,
}: DeviceHeroCardProps): ReactNode {
  const { i18n } = useTranslation()
  const { resolvedMode } = useThemeMode()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const system = useSystem()
  const { user } = useAuth()
  const features = device?.features ?? []
  const go = (path: string): void => {
    if (onNavigate === undefined) void navigate(path)
    else onNavigate(path)
  }
  return (
    <DeviceDetailModule
      deviceId={deviceId}
      trpcClient={system.trpcClient}
      queryClient={queryClient}
      theme={resolvedMode}
      locale={heroLang(i18n.language)}
      canActuate={user?.isAdmin === true}
      showName={false}
      defaultHistoryOpen={defaultHistoryOpen}
      {...(onDrawn !== undefined ? { onDrawn } : {})}
      onOpenDevice={(id) => go(`/devices/${String(id)}`)}
      onOpenCamera={(id) => go(`/devices/${String(id)}`)}
      onNavigate={go}
      {...(legacyFallback
        ? {
            fallback: (
              <DeviceHero
                deviceId={deviceId}
                deviceName={deviceName}
                deviceType={device?.type ?? 'unknown'}
                deviceRole={device?.role ?? null}
                provider={String(device?.addonId ?? 'rtsp')}
                isOnline={device?.online === true}
                features={features}
              />
            ),
          }
        : {})}
    />
  )
}
