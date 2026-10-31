import {
  Breadcrumb,
  ConfirmActionButton,
  countableDevices,
  deviceIntegrationResolver,
  type DeviceItemDevice,
  type DeviceItemParent,
  DeviceList,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  LogStream,
  OptionSelect,
  Switch,
  useAddonSettingsGetIntegrationFormSchema,
  useAddonSettingsGetIntegrationSettings,
  useAddonsRestartAddon,
  useDeviceManagerDisable,
  useDeviceManagerDiscoveryProviders,
  useDeviceManagerEnable,
  useDeviceManagerListAll,
  useDeviceManagerRemove,
  useIntegrationsDelete,
  useIntegrationsGet,
  useIntegrationsGetAvailableTypes,
  useIntegrationsList,
  useIntegrationsUpdate,
  useSystem,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Loader2,
  Plus,
  Radar,
  RefreshCw,
  ScrollText,
  SearchX,
  Settings,
  Trash2,
} from 'lucide-react'
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AddDeviceDialog } from '../components/integrations/AddDeviceDialog'
import { AddMatterDeviceDialog } from '../components/integrations/AddMatterDeviceDialog'
import { AdoptDevicesModal } from '../components/integrations/AdoptDevicesModal'
import { IntegrationConfigModal } from '../components/integrations/IntegrationConfigModal'
import type { IntegrationFormSeed } from '../components/integrations/integration-setup-seed'
import { ScanNetworkModal } from '../components/integrations/ScanNetworkModal'
import { NodeAddonsSettingsPanel } from '../components/settings/NodeAddonsSettingsPanel'
import { deviceIntegrationIcon } from '../components/shared/device-integration-icon'
import { useAddonIconUrl } from '../contexts/addon-icons-context'
import {
  INSTANCE_PARAM,
  integrationDetailUrl,
  resolveSelectedInstanceId,
} from '../lib/integration-instance-selection'
import { hasIntegrationSettings } from '../lib/settings-forwarding'

/**
 * `/integrations/:addonId` — one providing addon's integration page. The
 * instance it shows is `?instance=<integrationId>` (none → the first).
 */
export function IntegrationDetailPage(): ReactElement {
  const { addonId = '' } = useParams<{ addonId: string }>()
  return <AddonIntegrationsView addonId={addonId} />
}

function DetailSkeleton(): ReactElement {
  return (
    <div className="p-4">
      <div className="h-16 rounded-lg bg-surface animate-pulse mb-4" />
      <div className="h-40 rounded-lg bg-surface animate-pulse" />
    </div>
  )
}

interface AddonIntegrationsViewProps {
  readonly addonId: string
}

function AddonIntegrationsView({ addonId }: AddonIntegrationsViewProps): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const system = useSystem()
  const [showAddDevice, setShowAddDevice] = useState(false)
  const [adoptAfterCommission, setAdoptAfterCommission] = useState(false)
  const [showScan, setShowScan] = useState(false)
  const handleSetupIntegration = useCallback(
    (seed: IntegrationFormSeed) => {
      setShowScan(false)
      navigate('/integrations', { state: { integrationSeed: seed } })
    },
    [navigate],
  )
  const [showConfig, setShowConfig] = useState(false)
  const [showLogs, setShowLogs] = useState(false)

  // The addon's instances, and which one the page shows (`?instance=`; none
  // named → the first). Every action on the page — settings, enable/disable,
  // delete, add device, logs, restart — applies to that one instance.
  const { data: integrations } = useIntegrationsList(undefined)
  const instances = useMemo(
    () => (integrations ?? []).filter((i) => i.addonId === addonId),
    [integrations, addonId],
  )
  const integrationId = resolveSelectedInstanceId(searchParams.get(INSTANCE_PARAM), instances) ?? ''
  const onInstanceChange = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set(INSTANCE_PARAM, next)
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  const instanceOptions = useMemo(
    () => instances.map((i) => ({ value: i.id, label: i.name })),
    [instances],
  )

  const { data: integration, isLoading } = useIntegrationsGet(
    { id: integrationId },
    { enabled: !!integrationId },
  )

  // Route the "add devices" surface by CAP, never by addon name. The
  // available-types query carries the same `kind` metadata the wizard uses
  // (`device-adoption` → broker-backed Approach A integrations like Home
  // Assistant; `device-provider` → legacy config → discovery flow). We look
  // up this integration's addon by id and read its declared kind. When the
  // addon is `device-adoption` the add-device button opens the generic
  // AdoptDevicesModal (preview candidates → adopt); otherwise it keeps the
  // legacy AddDeviceDialog. This fixes the old "Provider unavailable" error for
  // integrations that lack a `device-provider` shim.
  // We must NOT default to `device-provider` while the available-types query
  // is still loading: clicking the button in that window would open the legacy
  // AddDeviceDialog and raise "Provider unavailable" for `device-adoption`
  // integrations (e.g. Home Assistant). So `integrationKind` stays `null`
  // until the types resolve, and the button is disabled while unresolved.
  const { data: availableTypes, isSuccess: typesReady } = useIntegrationsGetAvailableTypes()
  const integrationKind = useMemo<'device-adoption' | 'device-provider' | null>(() => {
    const addonId = integration?.addonId
    if (!addonId || !typesReady) return null
    const entry = (availableTypes ?? []).find((a) => a.addonId === addonId)
    // Addon not found in available-types after load (uninstalled/unavailable):
    // fall back to the legacy `device-provider` path — the least-surprising
    // choice, since real device-provider addons also lack a `device-adoption`
    // kind and this keeps their flow working.
    return entry?.kind === 'device-adoption' ? 'device-adoption' : 'device-provider'
  }, [availableTypes, integration?.addonId, typesReady])
  // Whether THIS integration's provider supports a network scan — gates the
  // per-integration "Scan network" button (with the extra-param form).
  const { data: discoveryProvidersData } = useDeviceManagerDiscoveryProviders({})
  const canScan = useMemo(
    () => (discoveryProvidersData?.providers ?? []).some((p) => p.addonId === integration?.addonId),
    [discoveryProvidersData, integration?.addonId],
  )
  // The add-device button stays disabled until the kind resolves, so the
  // operator can never open the wrong dialog during the loading window.
  const fabReady = integrationKind !== null
  // Label shared by the header add-device button (text + tooltip). Mirrors the
  // adopt-vs-add routing: a `device-adoption` integration adopts candidates,
  // a `device-provider` integration adds a device directly.
  /**
   * A FIXED integration is declared by an addon, not added by an operator — the
   * Notification Center's alarm panel is the first. It has no add or delete
   * flow, and the kernel REFUSES to delete one, so showing the buttons would
   * offer an action that answers with an error.
   */
  const isFixed = integration?.info?.['fixed'] === true

  // Broker kind for a `device-adoption` integration — sourced from the same
  // available-types entry the wizard uses (the addon manifest's `brokerKind`).
  // Drives the config modal's broker re-link step.
  const integrationBrokerKind = useMemo<string | null>(() => {
    const addonId = integration?.addonId
    if (!addonId || !typesReady) return null
    const entry = (availableTypes ?? []).find((a) => a.addonId === addonId)
    return entry?.brokerKind ?? null
  }, [availableTypes, integration?.addonId, typesReady])
  // Matter commissions a shared device (pairing code) before the operator
  // adopts the node. Other device-adoption integrations go straight to adopt.
  const isMatter = integrationBrokerKind === 'matter'
  const addDeviceLabel = !fabReady
    ? t('integrations.addDeviceLoading', { defaultValue: 'Loading…' })
    : isMatter
      ? t('integrations.addMatter.title', { defaultValue: 'Add Matter device' })
      : integrationKind === 'device-adoption'
        ? t('integrations.adoptDevices', { defaultValue: 'Adopt devices' })
        : t('integrations.addDevice')

  const integrationCanTest = useMemo(() => {
    const addonId = integration?.addonId
    if (!addonId || !typesReady) return false
    const entry = (availableTypes ?? []).find((a) => a.addonId === addonId)
    return entry?.canTest === true
  }, [availableTypes, integration?.addonId, typesReady])

  // Integration wizard `mode` (LOCKED MODEL) — sourced from the same
  // available-types entry. `standalone` integrations have NO integration-level
  // config, so their config/settings button is hidden. `null` until the types
  // resolve.
  const integrationMode = useMemo<'standalone' | 'account' | 'broker' | null>(() => {
    const addonId = integration?.addonId
    if (!addonId || !typesReady) return null
    const entry = (availableTypes ?? []).find((a) => a.addonId === addonId)
    return entry?.mode ?? null
  }, [availableTypes, integration?.addonId, typesReady])

  // `?add=1` deep-link (set by the wizard for a `standalone` integration it
  // just created) — auto-open the add/discover-device flow, then strip the
  // param so a manual close or a refresh doesn't re-open it. Waits for the
  // add-device kind to resolve (`fabReady`) so the correct dialog opens.
  useEffect(() => {
    if (searchParams.get('add') !== '1') return
    if (!fabReady) return
    setAdoptAfterCommission(false)
    setShowAddDevice(true)
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('add')
        return next
      },
      { replace: true },
    )
  }, [searchParams, fabReady, setSearchParams])

  // The form of THIS instance: the addon's per-instance schema when it has one (a hub's
  // connection only), else its global schema. Waits for the mode so the instance is complete.
  const { data: configSchema } = useAddonSettingsGetIntegrationFormSchema(
    {
      addonId: integration?.addonId ?? '',
      nodeId: 'hub',
      instance: { integrationId: integration?.id ?? null, mode: integrationMode ?? 'standalone' },
    },
    { enabled: !!integration?.addonId && integrationMode !== null },
  )

  const hasConfig =
    configSchema != null &&
    Array.isArray(configSchema.sections) &&
    configSchema.sections.some((s) => s.fields.length > 0)

  /**
   * Does this addon declare INTEGRATION-LEVEL SETTINGS? Core answers — the
   * addon named the sections in `BaseAddon.integrationSettingSections()` and
   * `getIntegrationSettings` returns `null` when it named none. There is no
   * allow-list of provider names in the admin UI: the provider declares, the
   * page obeys.
   *
   * `mode === 'account'` is refused, and the refusal is not cosmetic. An
   * account integration's Config modal renders the addon's schema through
   * `ProviderConfigForm` and saves it with `integrations.setSettings` — a
   * different store from `addonSettings.updateGlobalSettings`, and genuinely a
   * different table (`integration_settings` rows vs the addon's blob).
   * Rendering both on one page would put two controls with one label writing
   * two places: the defect this mechanism exists to prevent, reproduced by the
   * mechanism itself. `standalone` and `broker` have no such overlap — the
   * former has no integration-level config at all, the latter's modal only
   * re-links a broker.
   */
  const { data: integrationSettings } = useAddonSettingsGetIntegrationSettings(
    { addonId: integration?.addonId ?? '', nodeId: 'hub' },
    { enabled: !!integration?.addonId && integrationMode !== 'account' },
  )
  const hasIntegrationLevelSettings =
    integrationMode !== null &&
    integrationMode !== 'account' &&
    hasIntegrationSettings(integrationSettings)

  /**
   * Literal-stable id list for the panel. A fresh array on every render would
   * re-key the panel's `useQueries` each pass.
   */
  const integrationAddonIds = useMemo<readonly string[]>(
    () => (integration?.addonId ? [integration.addonId] : []),
    [integration?.addonId],
  )

  // Same "whole fleet, slim" shape as Devices.tsx / GlobalSearch /
  // Integrations.tsx, so this page shares that cache entry rather than
  // paying its own full, non-slim fetch. `refetchInterval` was 5 s — the
  // whole fleet does not change every second, and every other page reading
  // this same data lives on the query client's 30 s window (D274); 30 s keeps
  // this page's
  // online/offline column reasonably live without re-polling the full
  // registry 6x more often than every other consumer of the same data.
  const { data: allDevices } = useDeviceManagerListAll(
    { projection: 'slim' },
    { refetchInterval: 30_000 },
  )

  const integrationKey = [
    ['integrations', 'get'],
    { input: { id: integrationId }, type: 'query' },
  ] as const
  const toggleMutation = useIntegrationsUpdate({
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: integrationKey })
      const previous = queryClient.getQueryData(integrationKey)
      if (previous != null) {
        queryClient.setQueryData(integrationKey, {
          ...(previous as Record<string, unknown>),
          enabled: vars.enabled,
        })
      }
      return { previous }
    },
    onError: (_err, _next, context) => {
      const ctx = context as { previous?: unknown } | undefined
      if (ctx?.previous != null) {
        queryClient.setQueryData(integrationKey, ctx.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [['integrations']] })
      queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })

  const deleteMutation = useIntegrationsDelete({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['integrations']] })
      queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
      navigate(instances.length > 1 ? integrationDetailUrl(addonId) : '/integrations')
    },
  })

  // Kernel-level addon restart — same path as DeviceDetail's restart
  // button, but here it's the canonical surface (one button, one
  // addon). Resolves once the addon's lifecycle completes; queries
  // re-fetch on success so device statuses pick up the bounce.
  const restartAddonMutation = useAddonsRestartAddon({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['integrations']] })
      queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })

  // Per-device and batch device mutations — mirrors DeviceDetail's pattern.
  // All three invalidate the deviceManager query slice on success so the
  // list re-fetches with updated state.
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
  // with `DeviceItemDevice` — every required field is present. Boundary
  // cast mirrors the pattern in Devices.tsx + Integrations.tsx.
  const deviceList = useMemo<readonly DeviceItemDevice[]>(
    () => (allDevices ?? []) as readonly DeviceItemDevice[],
    [allDevices],
  )

  // Pre-built parent lookup table — same `listAll` snapshot, no extra
  // query per accessory row. Mirrors Devices.tsx + Integrations.tsx.
  const parentById = useMemo(() => {
    const byId = new Map<number, DeviceItemParent>()
    for (const d of deviceList) {
      byId.set(d.id, { id: d.id, name: d.name ?? d.stableId ?? `#${String(d.id)}` })
    }
    return byId
  }, [deviceList])

  const resolveParent = useCallback(
    (parentId: number): DeviceItemParent | null => parentById.get(parentId) ?? null,
    [parentById],
  )

  // Which integration each row belongs to — the ONE rule
  // (`deviceIntegrationResolver`): `integrationId` first, `addonId` only for
  // legacy rows. Membership is NOT `d.addonId === integration.addonId`: a
  // composed device is served by `composer` but was created by "Blocks"
  // (D659), and must be listed on the Blocks page. Same query key as
  // Devices / Integrations / GlobalSearch, so a warm client pays nothing.
  const integrationOf = useMemo(() => deviceIntegrationResolver(integrations), [integrations])
  const onDeviceNavigate = useCallback(
    (deviceId: number) => navigate(`/devices/${String(deviceId)}`),
    [navigate],
  )

  // Physical device count for this integration — uses `countableDevices`
  // from ui-library so the rule is consistent with the device-list footer.
  // Container entity-children are excluded (their Container parent counts
  // as one); Hub/NVR children remain countable. Passes only this
  // integration's devices so the parent-type lookup stays scoped to the
  // same set (Container parents are also in the integration's device list).
  const integrationDevices = useMemo<readonly DeviceItemDevice[]>(() => {
    return deviceList.filter((d) => {
      const resolved = integrationOf(d)
      return resolved.kind === 'resolved' && resolved.integration.id === integrationId
    })
  }, [deviceList, integrationId, integrationOf])

  // `null` while the integrations list has not answered: membership is not
  // known yet, and "0 devices" would claim an absence nobody observed (D315).
  const topLevelCount = useMemo(
    () => (integrations === undefined ? null : countableDevices(integrationDevices).length),
    [integrations, integrationDevices],
  )
  const topLevelCountLabel = topLevelCount ?? '…'

  if (isLoading || integrations === undefined) return <DetailSkeleton />

  const addonTitle =
    (availableTypes ?? []).find((a) => a.addonId === addonId)?.name ?? integration?.name ?? addonId

  if (!integration) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-6 text-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-foreground-subtle/10">
          <SearchX className="h-6 w-6 text-foreground-subtle" />
        </div>
        <div className="space-y-1 max-w-sm">
          <h2 className="text-sm font-semibold text-foreground">
            {t('integrations.integrationNotFound', { defaultValue: 'Integration not found' })}
          </h2>
          <p className="text-[11px] text-foreground-subtle">
            {t('integrations.integrationNotFoundHint', {
              defaultValue:
                'The integration "{{id}}" does not exist. It may have been deleted, or the URL may be wrong.',
              id: addonId,
            })}
          </p>
        </div>
        <button
          onClick={() => navigate('/integrations')}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[11px] font-medium text-foreground hover:bg-surface-hover transition-colors"
        >
          <ArrowLeft className="h-3 w-3" />
          {t('integrations.backToList', { defaultValue: 'Back to integrations' })}
        </button>
      </div>
    )
  }

  return (
    // `overflow-x-hidden`: the nested DeviceList table scrolls its own body
    // (sticky NAME + inner x-scroll); the page frame never h-scrolls.
    <div className="p-4 space-y-4 overflow-x-hidden">
      <Breadcrumb
        items={[
          {
            label: t('integrationDetail.integrations', 'Integrations'),
            onClick: () => navigate('/integrations'),
          },
          { label: addonTitle },
        ]}
      />

      {/* Header — wraps on narrow widths: the action cluster drops below the
          title rather than overflowing/overlapping it, and the title itself
          can shrink + truncate so a long integration name never pushes the
          buttons off-screen. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <IntegrationHeaderIcon addonId={integration.addonId} />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-foreground truncate">{addonTitle}</h1>
            <p className="text-[11px] text-foreground-subtle mt-0.5 truncate">
              {topLevelCountLabel} {t('integrations.devices')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Add-device — same primary header button as the Integrations list
              page. Routes to the adopt surface by the addon's declared cap kind
              (see `integrationKind`); disabled until the kind resolves. */}
          {canScan && (
            <button
              onClick={() => setShowScan(true)}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
              title={t(
                'integrationDetail.scanTheNetworkForDevices',
                'Scan the network for devices (incl. a different subnet)',
              )}
            >
              <Radar className="h-3.5 w-3.5" />
              {t('integrationDetail.scanNetwork', 'Scan network')}
            </button>
          )}
          {!isFixed && (
            <button
              onClick={() => {
                setAdoptAfterCommission(false)
                setShowAddDevice(true)
              }}
              disabled={!fabReady}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              title={addDeviceLabel}
            >
              <Plus className="h-3.5 w-3.5" />
              {addDeviceLabel}
            </button>
          )}
          <div
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 transition-colors ${
              toggleMutation.isPending ? 'opacity-60' : ''
            } ${
              integration.enabled ? 'border-success/30 bg-success/5' : 'border-border bg-surface'
            }`}
            title={t('integrations.toggleHint', { defaultValue: 'Click to toggle' })}
          >
            <Switch
              checked={integration.enabled}
              onCheckedChange={(next) =>
                toggleMutation.mutate({ id: integrationId!, enabled: next })
              }
              disabled={toggleMutation.isPending}
              aria-label={
                integration.enabled
                  ? t('integrationDetail.disableIntegration', 'Disable integration')
                  : t('integrationDetail.enableIntegration', 'Enable integration')
              }
            />
            <span
              className={`text-[11px] font-medium ${
                integration.enabled ? 'text-success' : 'text-foreground-subtle'
              }`}
            >
              {integration.enabled
                ? t('integrationDetail.enabled', 'Enabled')
                : t('integrationDetail.disabled', 'Disabled')}
            </span>
            {toggleMutation.isPending && (
              <Loader2 className="h-3 w-3 animate-spin text-foreground-subtle" />
            )}
          </div>
          {/* Config/settings button — HIDDEN for `mode: standalone` (those
              integrations have no integration-level config; connection lives
              per-device). Shown for `account`/`broker` when the addon has a
              settings schema or is a device-adoption (broker-backed) flow. */}
          {integrationMode !== 'standalone' &&
            (hasConfig || integrationKind === 'device-adoption') && (
              <button
                onClick={() => setShowConfig(true)}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[11px] text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
              >
                <Settings className="h-3 w-3" />
                {t('integrations.config')}
              </button>
            )}
          {/* Logs — addon-scoped (every device under this integration
              + addon-level chatter). When loggers carry an
              `integrationId` tag the modal narrows further; today it
              falls back to addonId because providers don't tag
              integrations yet. */}
          <button
            onClick={() => setShowLogs(true)}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[11px] text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
            title={t('integrations.logs', { defaultValue: 'View logs' })}
          >
            <ScrollText className="h-3 w-3" />
            {t('integrations.logs', { defaultValue: 'Logs' })}
          </button>
          {/* Restart addon — canonical surface for "bounce this
              integration". Bounces every device backed by the addon, so
              the confirm wording calls that out. */}
          <ConfirmActionButton
            label={t('integrationDetail.restart', 'Restart')}
            icon={RefreshCw}
            title={t('integrationDetail.restart2', 'Restart "{{name}}"?', {
              name: integration.name,
            })}
            description={t(
              'integrationDetail.restartingTheAddonWillBriefly',
              'Restarting the addon will briefly disconnect every device backed by it ({{topLevelCountLabel}} active). Streams will reconnect automatically.',
              { topLevelCountLabel },
            )}
            confirmLabel={t('integrationDetail.restart', 'Restart')}
            triggerVariant="outline"
            confirmVariant="danger"
            disabled={restartAddonMutation.isPending}
            action={() => restartAddonMutation.mutateAsync({ addonId: integration.addonId })}
          />
          {!isFixed && integrationId && (
            <ConfirmActionButton
              label={t('integrations.delete', { defaultValue: 'Delete' })}
              icon={Trash2}
              title={t('integrations.deleteTitle', { defaultValue: 'Delete integration?' })}
              description={t('integrations.deleteWarning', {
                defaultValue:
                  'This removes the integration "{{name}}" and its {{count}} device(s). The addon will restart. This cannot be undone.',
                name: integration.name,
                count: topLevelCountLabel,
              })}
              confirmLabel={t('integrations.confirmDelete', {
                defaultValue: 'Delete integration',
              })}
              triggerVariant="outline"
              confirmVariant="danger"
              className="border-danger bg-danger/10 text-danger hover:bg-danger hover:text-background"
              disabled={deleteMutation.isPending}
              action={() => deleteMutation.mutateAsync({ id: integrationId })}
            />
          )}
        </div>
      </div>

      {instances.length > 1 && (
        <div className="max-w-sm">
          <OptionSelect
            mode="single"
            singleDisplay="field"
            label={t('integrationDetail.instances', 'Integration')}
            options={instanceOptions}
            value={integrationId}
            onChange={onInstanceChange}
            testId="integration-instance-picker"
            optionTestIdPrefix="integration-instance"
          />
        </div>
      )}

      {/* INTEGRATION-LEVEL SETTINGS — the sections this addon declared as its
          integration's configuration. Rendered inline rather than behind the
          Config button because "easy accessibility" was the whole request: the
          operator looking for the Reolink SMTP port is already on this page.

          The panel supplies the scope statement itself and core supplies the
          selection; this call site cannot weaken either. `nodeId={null}` is not
          a stylistic choice — the panel THROWS on any node id, because a node
          heading over an addon-wide value is the `btmPath@hub` defect.

          An addon that declares nothing renders nothing here: core answers
          `null`, this block is absent, and the Config button below stays as it
          was. It is opt-in. */}
      {hasIntegrationLevelSettings && (
        <NodeAddonsSettingsPanel
          nodeId={null}
          addonIds={integrationAddonIds}
          level="global"
          surface="integration"
          title={t('integrations.settings', { defaultValue: 'Settings' })}
        />
      )}

      {/* Device list — shared composite, integration pre-applied via
          `forceIntegrationId` so the integration-chip group is hidden. URL
          scope is 'root' because this IS the root view for the page (no
          nesting). */}
      <DeviceList
        context="integration-detail"
        devices={deviceList}
        trpc={system.trpcClient}
        integrationOf={integrationOf}
        forceIntegrationId={integrationId}
        urlScope="root"
        lsKey={`integration-detail:${integration.addonId}`}
        resolveIntegrationIcon={deviceIntegrationIcon}
        resolveParent={resolveParent}
        onNavigate={onDeviceNavigate}
        batchActions={{
          remove: removeMutation.mutate,
          disable: disableMutation.mutate,
          enable: enableMutation.mutate,
        }}
        // Built-in confirmed per-row delete (table feature). The table renders
        // the red trash + the centered "Delete device?" confirm itself; we only
        // declare the destructive action. Replaces the former renderRowAction +
        // ad-hoc confirm stopgap.
        // A fixed integration's devices belong to the addon that declared them:
        // removing one leaves a hub that recreates it on the next boot, which
        // reads as a bug rather than as the refusal it is.
        {...(isFixed
          ? {}
          : { onDeleteDevice: (d: { id: number }) => removeMutation.mutate({ deviceId: d.id }) })}
      />

      {showAddDevice && integrationId && isMatter && !adoptAfterCommission && (
        <AddMatterDeviceDialog
          onClose={() => setShowAddDevice(false)}
          onCommissioned={() => setAdoptAfterCommission(true)}
        />
      )}

      {showAddDevice &&
        integrationId &&
        integrationKind === 'device-adoption' &&
        (!isMatter || adoptAfterCommission) && (
          <AdoptDevicesModal
            addonId={integration.addonId}
            integrationId={integrationId}
            onClose={() => {
              setShowAddDevice(false)
              setAdoptAfterCommission(false)
            }}
          />
        )}

      {showAddDevice && integrationId && integrationKind === 'device-provider' && (
        <AddDeviceDialog
          open={showAddDevice}
          integrationId={integrationId}
          addonId={integration.addonId}
          onClose={() => setShowAddDevice(false)}
        />
      )}

      {showScan && integration && (
        <ScanNetworkModal
          open={showScan}
          scope={{ addonId: integration.addonId, label: integration.name }}
          onClose={() => setShowScan(false)}
          onSetupIntegration={handleSetupIntegration}
        />
      )}

      {showConfig && integrationId && integrationKind !== null && integrationMode !== null && (
        <IntegrationConfigModal
          integrationId={integrationId}
          addonId={integration.addonId}
          name={integration.name}
          kind={integrationKind}
          mode={integrationMode}
          brokerKind={integrationBrokerKind}
          canTest={integrationCanTest}
          trpc={system.trpcClient}
          onClose={() => setShowConfig(false)}
        />
      )}

      {showLogs && (
        <Dialog open onOpenChange={(next) => !next && setShowLogs(false)}>
          <DialogContent
            width="lg"
            placement="sheet-on-mobile"
            scroll="body"
            className="md:max-w-5xl md:h-[80vh]"
          >
            <DialogHeader className="mb-0">
              <DialogTitle className="flex items-center gap-2 min-w-0">
                <ScrollText className="h-4 w-4 text-primary shrink-0" />
                <span className="truncate">{integration.name}</span>
                <span className="text-[10px] text-foreground-subtle font-mono truncate font-normal">
                  {integration.addonId}
                  {integrationId ? ` · ${integrationId}` : ''}
                </span>
              </DialogTitle>
            </DialogHeader>
            <DialogBody className="min-h-0 overflow-hidden p-0">
              {/* No `integrationId` filter today — providers don't tag
                  loggers with it yet, so adding it here would AND with
                  zero matches. addonId alone gives the union of every
                  device under this integration's addon, which is what
                  the operator actually wants in the unique-mode case
                  where 1 integration = 1 addon. When/if multi-instance
                  addons land we'll need providers to tag and the filter
                  here can be widened. */}
              <LogStream
                addonId={integration.addonId}
                limit={200}
                maxHeight="max-h-full"
                showScope={false}
                className="h-full border-0 rounded-none"
              />
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

/**
 * The integration's addon icon beside its name — drawn only when the addon's
 * manifest declares one, so an addon without an icon makes no request.
 */
function IntegrationHeaderIcon({ addonId }: { readonly addonId: string }): ReactElement | null {
  const src = useAddonIconUrl(addonId)
  const [broken, setBroken] = useState(false)
  if (!src || broken) return null
  return (
    <img src={src} alt="" className="h-8 w-8 rounded-lg shrink-0" onError={() => setBroken(true)} />
  )
}
