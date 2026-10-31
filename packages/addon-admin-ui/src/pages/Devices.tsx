/**
 * Devices page — universal grid of registered devices.
 *
 * Thin fetch-and-delegate wrapper around the shared `<DeviceList>`
 * composite. Owns:
 *   - `deviceManager.listAll` + `integrations.list` queries.
 *   - Cache invalidation against the relevant event categories.
 *   - Parent + integration-icon resolvers (closures over the same
 *     `listAll` snapshot — no per-row round-trips).
 *   - Page-level navigation (route to `/devices/:id`).
 *
 * Filtering, search, view toggle, pagination, and accessory grouping
 * all live inside `<DeviceList>` (see Phase 2 Task 12).
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Camera, AlertTriangle, Plug, Plus } from 'lucide-react'
import {
  Button,
  DeviceList,
  deviceIntegrationResolver,
  type DeviceItemDevice,
  type DeviceItemParent,
  type DeviceListIntegrationOption,
  useDeviceManagerDisable,
  useDeviceManagerEnable,
  useDeviceManagerListAll,
  useDeviceManagerRemove,
  useIntegrationsList,
  useSystem,
} from '@camstack/ui-library'

import { useEventInvalidation } from '../hooks/useEventInvalidation'
import { ProviderIcon } from '../components/shared/ProviderIcon'
import { deviceIntegrationIcon } from '../components/shared/device-integration-icon'
import { AdminPage } from '../components/AdminPage'
import { AddDevicePicker } from '../components/devices/AddDevicePicker'
import { BROWSE_INTEGRATIONS_URL } from '../lib/addon-kind-filter'
import { splitOrphanDevices } from './devices-orphan-split'

export function DevicesPage(): ReactNode {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [addOpen, setAddOpen] = useState(false)
  const system = useSystem()
  const queryClient = useQueryClient()

  useEventInvalidation(
    ['deviceManager'],
    [
      'device.registered',
      'device.unregistered',
      'device.online',
      'device.offline',
      'device.disabled',
      'device.enabled',
    ],
  )
  useEventInvalidation(
    ['integrations'],
    [
      'integration.enabled',
      'integration.disabled',
      'integration.deleted',
      'provider.started',
      'provider.stopped',
      'addon.installed',
      'addon.uninstalled',
      'addon.started',
      'addon.stopped',
    ],
  )

  // The universal device grid — every type, every field `<DeviceList>` reads
  // (id, name, type, online, …) except `config`, which no list row renders.
  // `slim` drops it (plus the per-device settings read it costs server-side)
  // and the query client's fleet window (D274) means the fleet is not re-fetched on every
  // remount — this is the SAME input GlobalSearch and Integrations.tsx pass,
  // so all three share one cache entry.
  const { data: devices } = useDeviceManagerListAll({ projection: 'slim' })
  // `integrations.*` is still a hand-written core router — codegen only
  // covers system caps. Keep the direct tRPC call until the integrations
  // surface is migrated to a capability.
  const { data: integrations } = useIntegrationsList(undefined)

  // Batch-mode bulk mutations — wired to the same `deviceManager` caps the
  // per-device surfaces use. Each invalidates the deviceManager query slice on
  // success so the list re-fetches with the updated disabled/removed state.
  // Mirrors the IntegrationDetail page's pattern.
  const removeMutation = useDeviceManagerRemove({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })
  const disableMutation = useDeviceManagerDisable({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })
  const enableMutation = useDeviceManagerEnable({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })

  // Wire shape from `deviceManager.listAll` is structurally compatible
  // with `DeviceItemDevice` — every required field (`id`, `stableId`,
  // `addonId`, `type`, `name`, `online`, `disabled`, `parentDeviceId`)
  // is present on `DeviceInfo` with the same types. The cast keeps the
  // pass-through immutable + readonly without re-mapping every row.
  const deviceList = useMemo<readonly DeviceItemDevice[]>(
    () => (devices ?? []) as readonly DeviceItemDevice[],
    [devices],
  )

  // Which integration each row belongs to — the ONE rule
  // (`deviceIntegrationResolver`): its `integrationId` (the integration that
  // CREATED it) when present, its `addonId` (the addon that SERVES it) only
  // for legacy rows. A composed device is created under "Blocks" but served
  // by `composer` (D659): the filter, the badge and the orphan split all ask
  // this, so none of them can file it under `composer` again. An UNANSWERED
  // integrations query resolves every row to `unknown` — not an empty list.
  const integrationOf = useMemo(() => deviceIntegrationResolver(integrations), [integrations])

  // Orphan split: a device is "orphan" when it names NO registered
  // integration (see `integrationOf` above). Causes of a
  // real orphan: the integration was deleted while devices were still in
  // the DB, an addon uninstalled, or a manifest rename left rows pointing
  // at a now-non-existent provider.
  //
  // Accessories: an accessory inherits orphan-ness from its parent (the
  // parent owns the integration link), AND ALSO is classified orphan
  // if its OWN link is unknown — covers the case where accessory
  // and parent live in different addons (e.g. a provider supplies the
  // camera, an accessory addon supplies the siren child) and only one
  // of the two integrations was deleted. Two separate sets so the
  // tree resolution doesn't depend on whether the parent row is also
  // present in the snapshot.
  const { activeDevices, orphanDevices } = useMemo(
    () =>
      // An UNANSWERED integrations query is not an empty one: on a slow
      // server the device list lands first, and classifying against an
      // empty set branded every device orphan for seconds. `integrationOf`
      // answers `unknown` then, which classifies nothing.
      splitOrphanDevices(deviceList, integrationOf),
    [deviceList, integrationOf],
  )

  // Pre-built parent lookup table — same `listAll` snapshot, no extra
  // query per accessory row. Mirrors the legacy implementation.
  const parentById = useMemo(() => {
    const byId = new Map<number, DeviceItemParent>()
    for (const d of deviceList) {
      byId.set(d.id, {
        id: d.id,
        name: d.name ?? d.stableId ?? `#${String(d.id)}`,
      })
    }
    return byId
  }, [deviceList])

  const resolveParent = useCallback(
    (parentId: number): DeviceItemParent | null => parentById.get(parentId) ?? null,
    [parentById],
  )

  const integrationOptions = useMemo<readonly DeviceListIntegrationOption[]>(
    () =>
      // Chip ids are INTEGRATION ids — matched against `integrationOf(row)`.
      (integrations ?? []).map((i) => ({
        id: i.id,
        name: i.name ?? i.addonId,
        icon: <ProviderIcon type={i.addonId} size="sm" />,
      })),
    [integrations],
  )

  const onNavigate = useCallback(
    (deviceId: number) => navigate(`/devices/${String(deviceId)}`),
    [navigate],
  )

  return (
    <AdminPage
      icon={Camera}
      title={t('nav.devices', 'Devices')}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => navigate(BROWSE_INTEGRATIONS_URL)}>
            <Plug className="h-3.5 w-3.5" />
            {t('devices.browseIntegrations', 'Browse integrations')}
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t('devices.addDevice.title', 'Add device')}
          </Button>
        </>
      }
    >
      <AddDevicePicker open={addOpen} onClose={() => setAddOpen(false)} />
      <DeviceList
        context="devices"
        devices={activeDevices}
        trpc={system.trpcClient}
        filters={{ integrations: integrationOptions }}
        integrationOf={integrationOf}
        resolveIntegrationIcon={deviceIntegrationIcon}
        resolveParent={resolveParent}
        onNavigate={onNavigate}
        batchActions={{
          remove: removeMutation.mutate,
          disable: disableMutation.mutate,
          enable: enableMutation.mutate,
        }}
      />

      {orphanDevices.length > 0 && (
        <div className="mt-6 space-y-2">
          <div className="flex items-baseline gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />
            <h2 className="text-sm font-semibold text-foreground">
              {t('devices.orphanDevices', 'Orphan devices')}
            </h2>
            <span className="text-[10px] text-foreground-subtle">
              {t('common.deviceOrphans', { count: orphanDevices.length })}
            </span>
          </div>
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-2">
            <p className="text-[11px] text-foreground-subtle px-2 pb-2">
              {t(
                'devices.theseDevicesReferenceAnIntegration',
                'These devices reference an integration that is no longer registered (their `integrationId`, or — for older devices without one — their `addonId`). Delete them, or re-install the missing integration to bring them back online. The provider badge beside each row is the addon that serves it.',
              )}
            </p>
            <DeviceList
              context="devices"
              devices={orphanDevices}
              trpc={system.trpcClient}
              // No integration chips: an orphan row belongs to no
              // integration by definition, so every chip would match nothing.
              integrationOf={integrationOf}
              urlScope="nested"
              lsKey="devices:orphan"
              resolveIntegrationIcon={deviceIntegrationIcon}
              resolveParent={resolveParent}
              onNavigate={onNavigate}
            />
          </div>
        </div>
      )}
    </AdminPage>
  )
}
