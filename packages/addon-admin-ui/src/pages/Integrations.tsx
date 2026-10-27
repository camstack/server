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
 *
 * The toolbar switches the list between the table and a card grid. The
 * choice is remembered in this browser; the table stays the default.
 * Pending, empty and error are the same in both layouts.
 */

import {
  cn,
  countableDevices,
  deviceIntegrationResolver,
  type DeviceItemDevice,
  type DeviceItemParent,
  DeviceList,
  ErrorBox,
  useDeviceManagerListAll,
  useIntegrationsGetAvailableTypes,
  useIntegrationsList,
  useSystem,
  ViewSwitch,
  type ViewSwitchOption,
} from '@camstack/ui-library'
import { LayoutGrid, Plug, Plus, Radar, RefreshCw, Table2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { AdminPage } from '../components/AdminPage'
import {
  groupIntegrationsByAddon,
  type IntegrationAddonGroup,
} from '../lib/integration-addon-groups'
import { integrationDetailUrl } from '../lib/integration-instance-selection'
import { IntegrationGrid } from '../components/integrations/integration-grid'
import {
  useIntegrationsView,
  type IntegrationsView,
} from '../components/integrations/integrations-view-preference'
import { IntegrationWizard } from '../components/integrations/IntegrationWizard'
import {
  readIntegrationSeed,
  type IntegrationFormSeed,
} from '../components/integrations/integration-setup-seed'
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
  const location = useLocation()
  const system = useSystem()
  const [searchParams] = useSearchParams()

  const [view, setView] = useIntegrationsView()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardSeed, setWizardSeed] = useState<IntegrationFormSeed | null>(null)
  const handleOpenWizard = useCallback(() => {
    setWizardSeed(null)
    setWizardOpen(true)
  }, [])
  const handleCloseWizard = useCallback(() => {
    setWizardOpen(false)
    setWizardSeed(null)
  }, [])
  const handleSetupIntegration = useCallback((seed: IntegrationFormSeed) => {
    setScanOpen(false)
    setWizardSeed(seed)
    setWizardOpen(true)
  }, [])
  const [scanOpen, setScanOpen] = useState(false)

  useEffect(() => {
    const routeSeed = readIntegrationSeed(location.state)
    if (routeSeed === null) return
    setWizardSeed(routeSeed)
    setWizardOpen(true)
    navigate('/integrations', { replace: true, state: null })
  }, [location.state, navigate])
  const setupAddonId = searchParams.get('setup')
  useEffect(() => {
    if (setupAddonId === null || setupAddonId.length === 0) return
    setWizardSeed({ addonId: setupAddonId, name: setupAddonId, config: {} })
    setWizardOpen(true)
  }, [setupAddonId])
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
    isError: integrationsFailed,
    refetch: refetchIntegrations,
  } = useIntegrationsList(undefined)

  // Same input as Devices.tsx / GlobalSearch — one shared cache entry for the
  // "whole fleet, slim" shape instead of three. The caching window is the
  // query client's (D274), so the three cannot drift apart.
  const {
    data: devices,
    isLoading: devicesLoading,
    isError: devicesFailed,
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

  // Friendly provider name per addon (the manifest `name`), for the grid card title.
  const { data: availableTypes } = useIntegrationsGetAvailableTypes()
  const addonNames = useMemo(
    () => new Map((availableTypes ?? []).map((a) => [a.addonId, a.name] as const)),
    [availableTypes],
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

  const addonGroups = useMemo(
    () => groupIntegrationsByAddon(tableRows, addonNames),
    [tableRows, addonNames],
  )
  const onGroupOpen = useCallback(
    (group: IntegrationAddonGroup) => navigate(integrationDetailUrl(group.addonId)),
    [navigate],
  )

  // Whole-row click → integration detail (replaces the per-row Settings button).
  const onRowClick = useCallback(
    (integration: Integration) =>
      navigate(integrationDetailUrl(integration.addonId, [integration.id])),
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

  const getKey = useCallback((integration: Integration): string => integration.id, [])

  const handleRefresh = useCallback(() => {
    void refetchIntegrations()
    void refetchDevices()
  }, [refetchIntegrations, refetchDevices])

  const listFailed = integrationsFailed === true || devicesFailed === true
  // An unanswered list is not an empty one (D315). `?? []` above is only for
  // the row map; the empty copy waits until both queries have answered.
  const awaiting =
    !listFailed &&
    (integrationsLoading || devicesLoading || integrations === undefined || devices === undefined)
  const hasIntegrations = integrationList.length > 0
  const viewOptions: readonly ViewSwitchOption<IntegrationsView>[] = [
    { id: 'table', label: t('integrations.viewTable', 'Table'), icon: Table2 },
    { id: 'grid', label: t('integrations.viewGrid', 'Grid'), icon: LayoutGrid },
  ]

  return (
    <AdminPage
      icon={Plug}
      title={t('nav.integrations', 'Integrations')}
      actions={
        <>
          <ViewSwitch
            ariaLabel={t('integrations.viewLabel', 'Layout')}
            value={view}
            onChange={setView}
            options={viewOptions}
            testId="integrations-view"
          />
          <button
            onClick={handleRefresh}
            disabled={awaiting}
            className="flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
            title={t('common.refresh', 'Refresh')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', awaiting && 'animate-spin')} />
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
      {listFailed && (
        <ErrorBox
          message={t('integrations.loadFailed', 'Integrations could not be loaded.')}
          onRetry={handleRefresh}
        />
      )}

      {awaiting && (
        <div className="space-y-2" data-testid="integrations-pending">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-12 rounded-lg border border-border bg-surface animate-pulse"
            />
          ))}
        </div>
      )}

      {!listFailed && !awaiting && !hasIntegrations && (
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

      {!listFailed && !awaiting && hasIntegrations && view === 'table' && (
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

      {!listFailed && !awaiting && hasIntegrations && view === 'grid' && (
        <IntegrationGrid
          groups={addonGroups}
          onOpen={onGroupOpen}
          searchPlaceholder={t('integrations.search', { defaultValue: 'Search integrations…' })}
          emptyLabel={t('integrations.empty', { defaultValue: 'No integrations found.' })}
        />
      )}

      <IntegrationWizard open={wizardOpen} onClose={handleCloseWizard} seed={wizardSeed} />
      <ScanNetworkModal
        open={scanOpen}
        onClose={handleCloseScan}
        onSetupIntegration={handleSetupIntegration}
      />
    </AdminPage>
  )
}
