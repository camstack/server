import type { DeviceType } from '@camstack/types'
import { ExtensionsPanel } from '@camstack/ui-library'
import { DeviceAggregateSection } from './DeviceAggregateSection'
import { showReadOnlyExtensionsInConfig } from './extensions-section'

interface ConfigTabProps {
  /** Numeric device id — propagated through to the aggregate query. */
  readonly deviceId: number
  /**
   * Controlled inner-tab id + change handler. DeviceDetail mirrors the
   * Config tab's inner-tab selection into the `?sub=` URL param so a
   * refresh/remount restores it. Optional — unset keeps internal state.
   */
  readonly activeSubTab?: string | null
  readonly onSubTabChange?: (id: string) => void
  /** Undefined while the device has not answered yet. */
  readonly deviceType?: DeviceType | undefined
  readonly isAdmin: boolean
}

/**
 * ConfigTab — the unified device-settings surface.
 *
 * Every aggregate setting (device identity, motion tuning, pipeline
 * routing, audio filters, streaming, PTZ, …) flows through the
 * device-manager aggregator (`deviceManager.getDeviceAggregate`) and
 * renders in `DeviceAggregateSection`. ConfigTab no longer composes
 * anything itself — placement is data, decided by each section's
 * `location` / `tab` metadata in the aggregate.
 *
 * The one exception (L4, D676): the Extensions card, read-only, for a
 * non-admin who cannot open Customize (`showReadOnlyExtensionsInConfig`).
 */
export function ConfigTab({
  deviceId,
  activeSubTab,
  onSubTabChange,
  deviceType,
  isAdmin,
}: ConfigTabProps) {
  return (
    <div className="flex flex-col gap-3">
      {showReadOnlyExtensionsInConfig(deviceType, isAdmin) && (
        <ExtensionsPanel deviceId={deviceId} readOnly />
      )}
      <DeviceAggregateSection
        deviceId={deviceId}
        activeSubTab={activeSubTab}
        onSubTabChange={onSubTabChange}
      />
    </div>
  )
}
