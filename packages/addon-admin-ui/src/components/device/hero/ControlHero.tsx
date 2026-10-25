import {
  DummyHeroCard,
  OfflineBadge,
  resolveDeviceControl,
  useDeviceProxy,
  useDeviceStateSlice,
  useSystem,
} from '@camstack/ui-library'
import { type ReactElement, useState } from 'react'
import type { HeroProps } from './HeroRegistry'
import { MotionTriggerToggle } from './MotionTriggerToggle'

/**
 * Generic registry-driven hero for all controllable device types.
 *
 * Looks up the device type's `HeroCard` from the ui-library control registry
 * (`resolveDeviceControl`) and renders it with the shared trpc client and the
 * device's features. Falls back to `DummyHeroCard` for types not yet wired in
 * the registry.
 *
 * It named AlarmPanel as that example long after `AlarmHeroCard` shipped. An
 * out-of-date example is a statement about what is MISSING, and this one sent
 * readers looking for a hero that has existed for months — so the example is
 * gone rather than replaced by one that will rot the same way.
 *
 * Offline affordance (Part C): when the auto-registered `device-status` slice
 * reports `online: false`, a single per-device `OfflineBadge` is shown in the
 * hero header. The HeroCard's controls already grey out and retain their
 * last-known value (gated by `useDeviceCapability.available`); this badge is
 * the one legible "why" + "last seen" indicator. The badge is read straight
 * from the device-status slice here so it appears exactly once per device,
 * never duplicated per cap/control.
 */
export function ControlHero({ deviceId, deviceType, features }: HeroProps): ReactElement {
  const system = useSystem()
  const control = resolveDeviceControl(deviceType)
  const HeroCard = control?.HeroCard ?? DummyHeroCard

  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const status = useDeviceStateSlice(dev?.state.deviceStatus)
  const [motionBusy, setMotionBusy] = useState(false)
  // Default ONLINE until the slice lands — never flash the badge during
  // initial load; only an explicit `online: false` surfaces it.
  const isOffline = status !== undefined && status.online === false
  const offlineSince = isOffline ? status.lastChangedAt : null

  return (
    <div className="flex h-full w-full flex-col items-stretch gap-3 p-3 sm:p-4">
      {isOffline ? (
        <div className="flex justify-center">
          <OfflineBadge lastChangedAt={offlineSince} />
        </div>
      ) : null}
      <HeroCard trpc={system.trpcClient} deviceId={deviceId} features={features} />
      {/* Motion-activation ("Trigger on motion"): self-gating — renders null
          unless the device exposes the `motion-trigger` cap (floodlights +
          sirens). The dedicated SwitchHero/LightHero carried this control
          before the registry consolidated Switch/Siren/Light onto ControlHero;
          hosting it here restores it for every controllable type with no
          per-type branching (cap presence is the gate). */}
      <div className="flex justify-center">
        <MotionTriggerToggle dev={dev} busy={motionBusy} setBusy={setMotionBusy} />
      </div>
    </div>
  )
}
