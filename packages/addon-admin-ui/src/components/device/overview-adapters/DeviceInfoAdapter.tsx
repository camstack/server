/**
 * DeviceInfoAdapter — custom-renderer for the `device-info` overview
 * field type. Contributed by `device-manager`'s base section, which
 * sets `placement.tab = 'overview'` so the existing Device Info block
 * lands inside the Overview tab instead of duplicating the data
 * inline.
 *
 * Two sub-tabs, both read-only. Name, room, type and display live on
 * Customize and save with that tab's one Save.
 *   - "Identity"  — id, stable id, provider, integration, parent,
 *                    capabilities. A container may still pick its primary child.
 *   - "Hardware"  — driver-populated metadata blob (manufacturer /
 *                    model / firmware / hardware / serial / uid /
 *                    mac / itemNo / …). Read-only — drivers refresh
 *                    on every probe / reconnect via setMetadata.
 *
 * Reads the cached device snapshot from `useDeviceSnapshot()` when the
 * host page provides one; otherwise falls back to a thin
 * `deviceManager.getDevice({ deviceId })` query so the adapter still
 * works in subtrees that haven't seeded the context.
 */
import { useState } from 'react'
import {
  useDeviceId,
  useDeviceManagerGetBindings,
  useDeviceManagerGetDevice,
  useDeviceSnapshot,
  Button,
} from '@camstack/ui-library'

import { CapabilityBadges } from '../../shared/CapabilityBadges'
import { ProviderIcon } from '../../shared/ProviderIcon'
import { InfoRow } from './shared/overview-primitives'
import { PrimaryChildRow } from './shared/PrimaryChildRow'
import { useTranslation } from 'react-i18next'

type SubTabId = 'identity' | 'hardware'

const HARDWARE_KEY_ORDER: readonly string[] = [
  'manufacturer',
  'model',
  'hardware',
  'firmware',
  'serialNumber',
  'uid',
  'mac',
  'itemNo',
] as const

function formatHardwareLabel(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (s) => s.toUpperCase())
}

function formatHardwareValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  return JSON.stringify(value)
}

export function DeviceInfoAdapter() {
  const { t } = useTranslation()
  const deviceId = useDeviceId()
  const cached = useDeviceSnapshot()
  // Always issue the network query for real-time updates after rename /
  // location edits — the cached snapshot is from the parent page query
  // which doesn't auto-invalidate on our mutations.
  const { data: fetched } = useDeviceManagerGetDevice(
    { deviceId: deviceId ?? 0 },
    { enabled: deviceId !== null },
  )
  // Bindings give the device's REAL bound capabilities — used as the
  // "Capabilities" fallback for devices that carry no DeviceFeature flags
  // (e.g. HA sensor children whose only cap is `binary` / `numeric-sensor`),
  // which would otherwise show "None".
  const { data: bindings } = useDeviceManagerGetBindings(
    { deviceId: deviceId ?? 0 },
    { enabled: deviceId !== null },
  )
  const device = (fetched as Record<string, unknown> | undefined) ?? cached ?? null
  const [activeSubTab, setActiveSubTab] = useState<SubTabId>('identity')

  if (deviceId === null || !device) return null

  const stableId = String(device.stableId ?? '')
  const provider = String(device.addonId ?? '')
  const integrationId =
    typeof device.integrationId === 'string' && device.integrationId.length > 0
      ? device.integrationId
      : null
  const parentDeviceId = typeof device.parentDeviceId === 'number' ? device.parentDeviceId : null
  const features = (device.features as readonly string[] | undefined) ?? []
  // Generic per-device infra caps every device carries — excluded from the
  // "Capabilities" fallback so it surfaces only what the device actually does.
  const INFRA_CAPS = new Set(['device-status', 'feature-probe', 'device-ops'])
  const nativeCaps = (
    (bindings as { entries?: readonly { capName: string; kind: string }[] } | undefined)?.entries ??
    []
  )
    .filter((e) => e.kind === 'native' && !INFRA_CAPS.has(e.capName))
    .map((e) => e.capName)
  // Show DeviceFeature flags when present (curated, camera-rich); otherwise
  // fall back to the device's native caps so sensors aren't shown as "None".
  const capabilityList = features.length > 0 ? features : nativeCaps
  const metadata = (device.metadata as Record<string, unknown> | null | undefined) ?? null
  const hasHardware = metadata !== null && Object.keys(metadata).length > 0

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      {/* Header + sub-tab strip. The Hardware tab only shows when the
       *  driver has populated at least one metadata field — devices
       *  without firmware-known facts (legacy drivers, hubs that
       *  don't probe getInfo) skip it entirely. */}
      <div className="border-b border-border px-3 sm:px-4 py-2 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">
          {t('overviewAdapters.deviceInfoAdapter.deviceInfo', 'Device Info')}
        </h2>
        {hasHardware && (
          <div className="flex items-center gap-1 rounded-md bg-surface-hover p-0.5">
            <SubTabButton
              active={activeSubTab === 'identity'}
              onClick={() => setActiveSubTab('identity')}
              label={t('overviewAdapters.deviceInfoAdapter.identity', 'Identity')}
            />
            <SubTabButton
              active={activeSubTab === 'hardware'}
              onClick={() => setActiveSubTab('hardware')}
              label={t('overviewAdapters.deviceInfoAdapter.hardware', 'Hardware')}
            />
          </div>
        )}
      </div>
      {(!hasHardware || activeSubTab === 'identity') && (
        <div className="divide-y divide-border">
          <InfoRow
            label="ID"
            value={
              <span className="font-mono text-[11px] text-foreground">
                {`#${deviceId}`}
                <span className="ml-1.5 text-foreground-subtle">({stableId})</span>
              </span>
            }
          />
          {/* Container-only: pick which child is primary. Self-gates to
           *  multi-child containers — renders nothing otherwise. */}
          <PrimaryChildRow deviceId={deviceId} />
          {integrationId !== null && (
            <InfoRow
              label={t('overviewAdapters.deviceInfoAdapter.integration', 'Integration')}
              value={<span className="font-mono text-[11px]">{integrationId}</span>}
            />
          )}
          {parentDeviceId !== null && (
            <InfoRow
              label={t('overviewAdapters.deviceInfoAdapter.parent', 'Parent')}
              value={<span className="font-mono text-[11px]">{`#${String(parentDeviceId)}`}</span>}
            />
          )}
          <InfoRow
            label={t('overviewAdapters.deviceInfoAdapter.provider', 'Provider')}
            value={<ProviderIcon type={provider} size="sm" showLabel />}
          />
          <InfoRow
            label={t('overviewAdapters.deviceInfoAdapter.capabilities', 'Capabilities')}
            value={
              capabilityList.length > 0 ? (
                <CapabilityBadges capabilities={capabilityList} showLabels />
              ) : (
                <span className="text-[11px] text-foreground-subtle">
                  {t('overviewAdapters.deviceInfoAdapter.none', 'None')}
                </span>
              )
            }
          />
        </div>
      )}
      {hasHardware && activeSubTab === 'hardware' && <HardwareInfoBody metadata={metadata!} />}
    </div>
  )
}

function SubTabButton({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <Button
      variant="unstyled"
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
        active
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-foreground-subtle hover:text-foreground'
      }`}
    >
      {label}
    </Button>
  )
}

function HardwareInfoBody({ metadata }: { metadata: Record<string, unknown> }) {
  const { t } = useTranslation()
  const knownKeys = HARDWARE_KEY_ORDER.filter((k) => k in metadata)
  const extraKeys = Object.keys(metadata)
    .filter((k) => !HARDWARE_KEY_ORDER.includes(k))
    .toSorted()
  const orderedKeys = [...knownKeys, ...extraKeys]

  return (
    <div>
      <div className="px-3 sm:px-4 py-1.5 text-[10px] text-foreground-subtle border-b border-border bg-surface-subtle/40">
        {t(
          'overviewAdapters.deviceInfoAdapter.autoPopulatedByTheDriver',
          'Auto-populated by the driver on every connect. Read-only.',
        )}
      </div>
      <div className="divide-y divide-border">
        {orderedKeys.map((key) => (
          <InfoRow
            key={key}
            label={formatHardwareLabel(key)}
            value={
              <span className="font-mono text-[11px] text-foreground break-all">
                {formatHardwareValue(metadata[key])}
              </span>
            }
          />
        ))}
      </div>
    </div>
  )
}
