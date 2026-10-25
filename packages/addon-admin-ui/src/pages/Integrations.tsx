/**
 * Integrations page — table-with-click-to-expand.
 *
 * Owns:
 *   - `integrations.list` + `deviceManager.listAll` queries.
 *   - Cache invalidation against integration / addon / device events.
 *   - URL state for the expanded row (`?expand=<addonId>`) so deep
 *     links to a specific integration's nested device list survive
 *     reload + back/forward navigation.
 *
 * Each expanded row renders a NESTED `<DeviceList>` filtered to that
 * integration (`forceIntegrationId`, rows resolved by
 * `deviceIntegrationResolver` — `urlScope='nested'`,
 * `lsKey='integrations:nested:<addonId>'` so each integration's
 * nested filter state is independent).
 *
 * Page-level "New Integration" wizard is preserved; the legacy
 * "Add Device" + per-section accordion + global type/search filters
 * have moved INTO the nested `<DeviceList>` (Phase 2 Task 12).
 */

import {
  cn,
  countableDevices,
  deviceIntegrationResolver,
  type DeviceItemDevice,
  type DeviceItemParent,
  DeviceList,
  useDeviceManagerListAll,
  useIntegrationsList,
  useSystem,
} from '@camstack/ui-library'
import { Plug, Plus, Radar, RefreshCw } from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AdminPage } from '../components/AdminPage'
import { IntegrationWizard } from '../components/integrations/IntegrationWizard'
import {
  buildIntegrationColumns,
  type Integration,
  type IntegrationRowStatus,
} from '../components/integrations/integration-columns'
import { ScanNetworkModal } from '../components/integrations/ScanNetworkModal'
import { deviceIntegrationIcon } from '../components/shared/device-integration-icon'
import { useEventInvalidation } from '../hooks/useEventInvalidation'

interface IntegrationListItem {
  readonly id: string
  readonly addonId: string
  readonly name: string
  readonly enabled: boolean
  readonly processState: string
}

function deriveStatus(integration: IntegrationListItem): IntegrationRowStatus {
  if (!integration.enabled) return 'disabled'
  switch (integration.processState) {
    case 'running':
      return 'running'
    case 'stopped':
    case 'crashed':
    case 'unknown':
    default:
      return 'stopped'
  }
}

const EXPAND_PARAM = 'expand'

export function IntegrationsPage(): ReactNode {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const system = useSystem()
  const [searchParams] = useSearchParams()

  const [wizardOpen, setWizardOpen] = useState(false)
  const handleOpenWizard = useCallback(() => setWizardOpen(true), [])
  const handleCloseWizard = useCallback(() => setWizardOpen(false), [])
  const [scanOpen, setScanOpen] = useState(false)
  const handleOpenScan = useCallback(() => setScanOpen(true), [])
  const handleCloseScan = useCallback(() => setScanOpen(false), [])

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
      'addon.updated',
    ],
  )
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

  // `integrations.*` is still a hand-written core router — codegen only
  // covers system caps. Keep the direct tRPC call until the integrations
  // surface is migrated to a capability.
  const {
    data: integrations,
    isLoading: integrationsLoading,
    refetch: refetchIntegrations,
  } = useIntegrationsList(undefined)

  // Same input as Devices.tsx / GlobalSearch — one shared cache entry for the
  // "whole fleet, slim" shape instead of three. The caching window is the
  // query client's (D274), so the three cannot drift apart.
  const {
    data: devices,
    isLoading: devicesLoading,
    refetch: refetchDevices,
  } = useDeviceManagerListAll({ projection: 'slim' })

  // Wire shape from `deviceManager.listAll` is structurally compatible with
  // `DeviceItemDevice` — every required field is present on `DeviceInfo`
  // with the same types. The single deliberate boundary cast keeps the
  // pass-through immutable + readonly without re-mapping every row
  // (mirrors the pattern used in Devices.tsx).
  const deviceList = useMemo<readonly DeviceItemDevice[]>(
    () => (devices ?? []) as readonly DeviceItemDevice[],
    [devices],
  )

  const integrationList = useMemo<readonly IntegrationListItem[]>(
    () => integrations ?? [],
    [integrations],
  )

  // Pre-built parent lookup table — same `listAll` snapshot, no extra
  // query per accessory row. Mirrors Devices.tsx.
  const parentById = useMemo(() => {
    const byId = new Map<number, DeviceItemParent>()
    for (const d of deviceList) {
      byId.set(d.id, { id: d.id, name: d.name ?? d.stableId ?? `#${String(d.id)}` })
    }
    return byId
  }, [deviceList])

  // Which integration each row belongs to — the ONE rule
  // (`deviceIntegrationResolver`): `integrationId` first, `addonId` only for
  // legacy rows. A composed device is served by `composer` but belongs to
  // "Blocks" (D659), so it counts — and lists — under Blocks.
  const integrationOf = useMemo(() => deviceIntegrationResolver(integrations), [integrations])

  // Per-integration device count — driven off the same `listAll` snapshot,
  // using the shared `countableDevices` rule so a Container counts as ONE
  // device (its entity-children are excluded) while a Hub/NVR's children still
  // count. Same rule the integration-detail page uses, so the two never
  // disagree.
  const deviceCountByIntegration = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of countableDevices(deviceList)) {
      const resolved = integrationOf(d)
      if (resolved.kind !== 'resolved') continue
      const key = resolved.integration.id
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [deviceList, integrationOf])

  const tableRows = useMemo<readonly Integration[]>(
    () =>
      integrationList.map((i) => ({
        id: i.id,
        addonId: i.addonId,
        name: i.name,
        enabled: i.enabled,
        status: deriveStatus(i),
        deviceCount: deviceCountByIntegration.get(i.id) ?? 0,
      })),
    [integrationList, deviceCountByIntegration],
  )

  const expandedAddonId = searchParams.get(EXPAND_PARAM)

  // URL-driven expand toggle. Use `history.replaceState` +
  // synthetic `popstate` to avoid a full route re-render — same
  // pattern the spec calls for (keeps `<DeviceList>`'s nested
  // url-state hook in sync with the outer `?expand=` param).
  const setExpand = useCallback((addonId: string) => {
    const params = new URLSearchParams(window.location.search)
    const current = params.get(EXPAND_PARAM)
    if (current === addonId) {
      params.delete(EXPAND_PARAM)
    } else {
      params.set(EXPAND_PARAM, addonId)
    }
    const nextSearch = params.toString()
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
    window.history.replaceState(window.history.state, '', nextUrl)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [])

  // Whole-row click → integration detail (replaces the per-row Settings button).
  const onRowClick = useCallback(
    (integration: Integration) => navigate(`/integrations/${integration.id}`),
    [navigate],
  )

  const resolveParent = useCallback(
    (parentId: number): DeviceItemParent | null => parentById.get(parentId) ?? null,
    [parentById],
  )

  const onNavigate = useCallback(
    (deviceId: number) => navigate(`/devices/${String(deviceId)}`),
    [navigate],
  )

  const renderExpanded = useCallback(
    (integration: Integration): ReactNode => (
      <DeviceList
        context="integration-detail"
        devices={deviceList}
        trpc={system.trpcClient}
        integrationOf={integrationOf}
        forceIntegrationId={integration.id}
        urlScope="nested"
        lsKey={`integrations:nested:${integration.addonId}`}
        resolveIntegrationIcon={deviceIntegrationIcon}
        resolveParent={resolveParent}
        onNavigate={onNavigate}
      />
    ),
    [deviceList, system.trpcClient, integrationOf, resolveParent, onNavigate],
  )

  // Single-open expansion driven by the `?expand=<addonId>` URL param — the
  // same behavior the bespoke table had. Generic-mode owns the colSpan
  // expansion row; the chevron lives in the `name` cell wired to `setExpand`.
  const isExpanded = useCallback(
    (integration: Integration): boolean => expandedAddonId === integration.addonId,
    [expandedAddonId],
  )

  const integrationColumns = useMemo(
    () =>
      buildIntegrationColumns({
        isExpanded,
        onToggleExpand: setExpand,
      }),
    [isExpanded, setExpand],
  )

  const getSearchText = useCallback(
    (integration: Integration): string => `${integration.name} ${integration.addonId}`,
    [],
  )

  const getKey = useCallback((integration: Integration): string => integration.addonId, [])

  const handleRefresh = useCallback(() => {
    void refetchIntegrations()
    void refetchDevices()
  }, [refetchIntegrations, refetchDevices])

  const isLoading = integrationsLoading || devicesLoading
  const hasIntegrations = integrationList.length > 0

  return (
    <AdminPage
      icon={Plug}
      title={t('nav.integrations', 'Integrations')}
      actions={
        <>
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
            title={t('common.refresh', 'Refresh')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </button>
          <button
            onClick={handleOpenScan}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
            title={t('integrations.scanTheLocalNetworkFor', 'Scan the local network for devices')}
          >
            <Radar className="h-3.5 w-3.5" />
            {t('integrations.scanNetwork', 'Scan network')}
          </button>
          <button
            onClick={handleOpenWizard}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('integrations.newIntegration', 'New Integration')}
          </button>
        </>
      }
    >
      {/* Loading skeleton */}
      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-12 rounded-lg border border-border bg-surface animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !hasIntegrations && (
        <div className="flex flex-col items-center py-20 text-foreground-subtle">
          <p className="text-sm">
            {t('integrations.noIntegrationsConfigured', 'No integrations configured.')}
          </p>
          <p className="text-xs mt-1">
            {t(
              'integrations.clickNewIntegrationToConnect',
              'Click "New Integration" to connect cameras and devices.',
            )}
          </p>
        </div>
      )}

      {/* Table — unified generic-mode DeviceList. Each integration row expands
          to a nested device list filtered to that integration. */}
      {!isLoading && hasIntegrations && (
        <DeviceList
          mode="generic"
          items={tableRows}
          getKey={getKey}
          getSearchText={getSearchText}
          columns={integrationColumns}
          onRowClick={onRowClick}
          isExpanded={isExpanded}
          renderExpanded={renderExpanded}
          searchPlaceholder={t('integrations.search', { defaultValue: 'Search integrations…' })}
          emptyLabel={t('integrations.empty', { defaultValue: 'No integrations found.' })}
        />
      )}

      <IntegrationWizard open={wizardOpen} onClose={handleCloseWizard} />
      <ScanNetworkModal open={scanOpen} onClose={handleCloseScan} />
    </AdminPage>
  )
}
