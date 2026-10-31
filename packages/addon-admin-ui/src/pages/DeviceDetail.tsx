import {
  type ConfigSection,
  DeviceFeature,
  DeviceType,
  WELL_KNOWN_TAB_MAP,
  type WellKnownTab,
} from '@camstack/types'
import {
  BatteryBadge,
  Breadcrumb,
  DeviceHistoryView,
  type ContainerChild,
  DeviceContextProvider,
  getPhaseVisual,
  KebabMenu,
  type KebabMenuItem,
  NetworkLinkBadge,
  PlayerOverlaysProvider,
  RecordedPlaybackProvider,
  resolveContainerPrimary,
  resolveDeviceIntegration,
  SNAPSHOT_MEDIA_PATH,
  StatusBadge,
  deviceTypeMetaOf,
  RunningBadge,
  useAddonsRestartAddon,
  useDeviceState,
  useAudioMetricsGetCurrentSnapshot,
  useConfirm,
  useDeviceBattery,
  useDeviceNetworkLink,
  useDeviceManagerDisable,
  useDeviceManagerEnable,
  useDeviceManagerGetDevice,
  useDeviceManagerGetDeviceAggregate,
  useDeviceManagerRemove,
  useIntegrationsList,
  useIsMobile,
  usePipelineOrchestratorGetPipelineAssignment,
  usePipelineRunnerGetCameraMetrics,
  useRebootReboot,
  useSystem,
  VodPlaybackProvider,
  ZoneEditingProvider,
  useDeviceLabel,
  useUiText,
  type DeviceNameFields,
  Button,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  Bell,
  Camera,
  Cpu,
  Database,
  Power,
  RefreshCw,
  RotateCw,
  ScrollText,
  Terminal,
  Trash2,
  Volume2,
} from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { integrationDetailUrl } from '../lib/integration-instance-selection'
import { STEP_INSPECTOR_PARAMS } from '../lib/step-url-selection'
import { CameraFunctionSwitches } from '../components/device/CameraFunctionSwitches'
import { DeviceAdminLinkButton } from '../components/device/DeviceAdminLinkButton'
import { ChildrenList } from '../components/device/ChildrenList'
import { DeviceHero } from '../components/device/hero/HeroRegistry'
import { DeviceHeroWidgets } from '../components/device/hero/DeviceHeroWidgets'
import { heroWidgets } from '../components/device/hero/hero-widgets'
import {
  EventsPanelContent,
  LogsPanelContent,
  ReplPanelContent,
  StatePanelContent,
  StreamPanelContent,
} from '../components/device/PanelContent'
import { CustomizeTab } from '../components/device/customize/CustomizeTab'
import { resolveActiveDeviceTab } from '../components/device/tabs/active-device-tab'
import { BindingsTab } from '../components/device/tabs/BindingsTab'
import { ConfigTab } from '../components/device/tabs/ConfigTab'
import { DetectionPipelineTab } from '../components/device/tabs/DetectionPipelineTab'
import { DeviceAggregateSection } from '../components/device/tabs/DeviceAggregateSection'
import { hasConfigTabContent } from '../components/device/tabs/config-tab-sections'
import {
  DEVICE_EXPORT_TAB_ID,
  DEVICE_EXPORT_TAB_LABEL,
  isDeviceExportSection,
} from '../components/device/tabs/device-export-tab'
import { OverviewTab } from '../components/device/tabs/OverviewTab'
import { HISTORY_TAB_ID, structuralTabsFor } from '../components/device/tabs/structural-tabs'
import { CapabilityBadges } from '../components/shared/CapabilityBadges'
import { IntegrationLogoLink } from '../components/shared/IntegrationLogoLink'
import { useAuth } from '../contexts/auth-context'
import { useDeviceChildren } from '../hooks/useDevice'
import { authedDownload } from '../lib/authed-media.js'
import { CUSTOMIZE_TAB_ID } from '../lib/customization-routes'
import { Trans, useTranslation } from 'react-i18next'

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

// The structural tab table (overview / config / customize / detection-pipeline
// / bindings) and its per-type and admin filters live in
// `components/device/tabs/structural-tabs.ts` (D676).

interface TabEntry {
  readonly id: string
  readonly label: string
  /** True when this tab is contributed by an addon section (`location: 'top-tab'`). */
  readonly isAddonContrib?: boolean
  /**
   * Set when this top-tab is promoted from the container's PRIMARY CHILD (e.g.
   * a vacuum's Consumables tab surfaced on its container). The tab body then
   * renders the child's aggregate (this id), not the container's.
   */
  readonly childDeviceId?: number
}

type TabId = string

// ---------------------------------------------------------------------------
// Common-panels strip (left column tab block)
// ---------------------------------------------------------------------------

// Common-panels tab block. Always visible in the left column under the
// hero (desktop and tablet) and stacked between hero and settings on
// mobile. Cross-cutting dev/ops surfaces only.
//
// NB on what's intentionally NOT here:
//   - PTZ: the `ptz` / `ptz-autotrack` caps contribute their settings
//     sections to the device aggregate with `location: 'top-tab'`, so
//     PTZ surfaces as an aggregate-driven top-level tab discovered the
//     same way the pipeline "Zones" tab is. A bespoke shortcut here
//     would duplicate that single declarative surface — placement is
//     data, never hard-coded.
//   - Intercom: starts/stops directly from the stream player toolbar
//     button — no panel UI needed since the only state is "talking
//     yes/no" surfaced by the button highlight.
//   - Restart: the page header's KebabMenu already exposes "Reboot
//     device" and "Restart addon" at every breakpoint, so a dedicated
//     tab here would duplicate without adding affordance.
type CommonShortcutId = 'repl' | 'logs' | 'events' | 'state'

interface CommonShortcutConfig {
  readonly id: CommonShortcutId
  readonly icon: React.ComponentType<{ className?: string }>
  readonly labelKey: string
  readonly featureGate?: DeviceFeature
}

const COMMON_SHORTCUTS: readonly CommonShortcutConfig[] = [
  { id: 'logs', icon: ScrollText, labelKey: 'common.logs' },
  { id: 'repl', icon: Terminal, labelKey: 'deviceDetail.repl' },
  { id: 'events', icon: Bell, labelKey: 'common.events' },
  { id: 'state', icon: Database, labelKey: 'common.state' },
]

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function DeviceDetailPage() {
  const { t } = useTranslation()
  const uiText = useUiText()
  const params = useParams<{ deviceId: string }>()
  const deviceId = Number(params.deviceId)
  const isValidDeviceId = Number.isFinite(deviceId)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const system = useSystem()
  const { user } = useAuth()
  const isAdmin = user?.isAdmin === true
  // ── Tab + inner-sub-tab persisted in the URL ──────────────────────
  //
  // The URL is the single source of truth for the active top-level tab
  // (`?tab=`) and the active inner sub-tab (`?sub=`), so a refresh /
  // remount restores exactly where the operator was. We never keep a
  // parallel `useState` for these — `activeTab` is derived below from
  // the URL param VALIDATED against the tabs actually available for this
  // device (async-discovered addon top-tabs included). An unknown /
  // not-yet-discovered id stays pending in the URL and falls back to
  // 'overview' for rendering WITHOUT rewriting the URL, so the desired
  // tab snaps in once discovery completes instead of being lost.
  const [searchParams, setSearchParams] = useSearchParams()
  const desiredTab = searchParams.get('tab') ?? 'overview'
  const desiredSub = searchParams.get('sub')
  // Single shortcut state — drives both the desktop left-column tab
  // block and the mobile inline tab strip. Default = `logs` so users
  // landing on the page see live logs immediately.
  const [activeShortcut, setActiveShortcut] = useState<CommonShortcutId>('logs')

  // Persisted width of the left column (px) — drag the divider to
  // resize. `null` falls back to the responsive default `w-1/2 lg:w-1/3`.
  // Mobile ignores this entirely (everything stacks).
  const LEFT_COL_STORAGE_KEY = 'device-detail.left-col-width-px'
  const [leftColWidthPx, setLeftColWidthPx] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(LEFT_COL_STORAGE_KEY)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  })
  // Track the live value during drag without re-saving on every
  // mousemove; we persist once on mouseup.
  const liveLeftColWidthRef = useRef<number | null>(leftColWidthPx)
  liveLeftColWidthRef.current = leftColWidthPx

  function startResizingLeftCol(startEvent: React.MouseEvent<HTMLDivElement>) {
    startEvent.preventDefault()
    const startX = startEvent.clientX
    // Snapshot the rendered width — we may not have a numeric override
    // yet (responsive default), in which case the resizer starts from
    // the current measured pixel width.
    const startWidth =
      (
        startEvent.currentTarget.previousElementSibling as HTMLElement | null
      )?.getBoundingClientRect().width ??
      leftColWidthPx ??
      0
    const minWidth = 280
    const maxWidth = Math.max(minWidth + 50, Math.floor(window.innerWidth * 0.7))
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(minWidth, Math.min(maxWidth, startWidth + (ev.clientX - startX)))
      setLeftColWidthPx(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const finalWidth = liveLeftColWidthRef.current
      if (finalWidth !== null) {
        try {
          window.localStorage.setItem(LEFT_COL_STORAGE_KEY, String(Math.round(finalWidth)))
        } catch {
          /* swallow */
        }
      }
      // Re-enable text selection that we suppressed during drag.
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    // Suppress text selection across the page while dragging so the
    // user doesn't accidentally select form labels.
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const {
    data: deviceData,
    isLoading,
    isError,
  } = useDeviceManagerGetDevice(
    { deviceId },
    {
      enabled: isValidDeviceId,
      refetchInterval: 5_000,
      retry: 1,
    },
  )

  // Discover addon-contributed top tabs from the device aggregate.
  // Sections marked `location: 'top-tab'` (e.g. orchestrator's Zones
  // contribution) are grouped by `tab` id; each unique tab id becomes
  // its own top-level tab. Label/icon defaults come from
  // `WELL_KNOWN_TAB_MAP`. The same query powers `DeviceAggregateSection`
  // inside ConfigTab — react-query dedups, no extra round trip.
  const { data: aggregateData } = useDeviceManagerGetDeviceAggregate(
    { deviceId },
    { enabled: isValidDeviceId },
  )

  const addonTabs: readonly TabEntry[] = useMemo(() => {
    const settingsSections = (aggregateData?.settings?.sections ?? []) as readonly ConfigSection[]
    const liveSections = (aggregateData?.live?.sections ?? []) as readonly ConfigSection[]
    const allSections = [...settingsSections, ...liveSections]
    // Camera-only addons gate their contribution server-side now —
    // non-camera devices receive an empty section list, so the top-tab
    // bar stays clean without a separate client-side allow-list.
    const tabIds = new Set<string>()
    for (const s of allSections) {
      // Merge the standalone "Detection" tab (zones + rules, `tab: 'zones'`)
      // INTO "Detection pipeline" (`tab: 'detection-pipeline'`): zones render as
      // their own section inside the pipeline tab instead of a separate tab.
      if (s.location === 'top-tab' && s.tab)
        tabIds.add(s.tab === 'zones' ? 'detection-pipeline' : s.tab)
    }
    // `device-export` addons (HAP / Alexa / HA-MQTT) contribute sections
    // with `tab: 'export'` but default `location: 'settings'`. We
    // promote them to a top-level tab client-side — see
    // `device-export-tab.ts` for the detection helper and rationale.
    // The export providers already gate their contributions to camera
    // devices server-side (`isCameraDevice`); non-camera devices
    // receive null, so this set stays empty for them.
    const hasExportSection = allSections.some(isDeviceExportSection)
    if (hasExportSection) tabIds.add(DEVICE_EXPORT_TAB_ID)
    return [...tabIds].map((id) => {
      if (id === DEVICE_EXPORT_TAB_ID) {
        return { id, label: DEVICE_EXPORT_TAB_LABEL, isAddonContrib: true } satisfies TabEntry
      }
      const wk = WELL_KNOWN_TAB_MAP[id as keyof typeof WELL_KNOWN_TAB_MAP] as
        | WellKnownTab
        | undefined
      // No render-time capitalization fallback — drivers should either
      // reference a well-known tab id (label comes from
      // `WELL_KNOWN_TAB_MAP`) or declare their own via `schema.tabs`.
      // The raw id is used as the label when neither applies; this
      // surfaces missing declarations loudly instead of papering over
      // them with an ad-hoc transform.
      return { id, label: wk?.label ?? id, isAddonContrib: true } satisfies TabEntry
    })
  }, [aggregateData])

  const device = deviceData
  const storedName = String(device?.name ?? params.deviceId ?? 'Device')
  const isOnline = device?.online === true
  const status = isOnline ? 'online' : 'offline'
  const provider = String(device?.addonId ?? 'rtsp')
  const capabilities = device?.features ?? []
  const deviceTypeStr = device?.type
  const isCamera = deviceTypeStr === DeviceType.Camera

  // Container → primary-child tab promotion. A container has no deviceConfig
  // surface of its own; its PRIMARY child (resolved by the same durable-pick /
  // priority rule the hero uses) carries the deviceConfig top-tabs — e.g. a
  // vacuum's Consumables. We discover the child's top-tabs and surface them on
  // the container so the operator never has to drill into the child to reach
  // them. Drives the Children section visibility in the Overview tab too.
  const { data: childrenData } = useDeviceChildren(isValidDeviceId ? deviceId : 0)
  const isContainer = deviceTypeStr === DeviceType.Container
  const containerChildren: readonly ContainerChild[] = useMemo(
    () =>
      (childrenData ?? []).map((c) => ({
        id: c.id,
        stableId: c.stableId,
        type: c.type,
        ...(c.sourceInfo ? { sourceInfo: { id: c.sourceInfo.id } } : {}),
      })),
    [childrenData],
  )
  const primaryChildId = useMemo<number | null>(() => {
    if (!isContainer) return null
    const link = typeof device?.linkDeviceId === 'number' ? device.linkDeviceId : null
    const pcid =
      typeof device?.primaryChildEntityId === 'string' ? device.primaryChildEntityId : null
    return resolveContainerPrimary(containerChildren, link, pcid)?.id ?? null
  }, [isContainer, containerChildren, device?.linkDeviceId, device?.primaryChildEntityId])

  // The primary child's aggregate — fetched only for a container with a
  // resolved primary child. Powers the promoted top-tabs below.
  const { data: childAggregateData } = useDeviceManagerGetDeviceAggregate(
    { deviceId: primaryChildId ?? 0 },
    { enabled: primaryChildId !== null },
  )
  const childAddonTabs: readonly TabEntry[] = useMemo(() => {
    if (primaryChildId === null) return []
    const settingsSections = (childAggregateData?.settings?.sections ??
      []) as readonly ConfigSection[]
    const liveSections = (childAggregateData?.live?.sections ?? []) as readonly ConfigSection[]
    const tabIds = new Set<string>()
    for (const s of [...settingsSections, ...liveSections]) {
      if (s.location === 'top-tab' && s.tab) tabIds.add(s.tab)
    }
    return [...tabIds].map((id) => {
      const wk = WELL_KNOWN_TAB_MAP[id as keyof typeof WELL_KNOWN_TAB_MAP] as
        | WellKnownTab
        | undefined
      return {
        id,
        label: wk?.label ?? id,
        isAddonContrib: true,
        childDeviceId: primaryChildId,
      } satisfies TabEntry
    })
  }, [primaryChildId, childAggregateData])
  // Under the hero card (D915): every `hero` widget the device's bindings
  // declare (the Consumables panel), plus the primary child's on a container.
  // Data, not device type — the server emits the section per binding.
  const heroSectionWidgets = useMemo(
    () =>
      heroWidgets({
        sections: [
          ...(aggregateData?.settings?.sections ?? []),
          ...(aggregateData?.live?.sections ?? []),
        ],
        deviceId,
        ...(primaryChildId !== null
          ? {
              child: {
                sections: [
                  ...(childAggregateData?.settings?.sections ?? []),
                  ...(childAggregateData?.live?.sections ?? []),
                ],
                deviceId: primaryChildId,
              },
            }
          : {}),
      }),
    [aggregateData, childAggregateData, deviceId, primaryChildId],
  )
  // Parent device — surfaced as a clickable link under the title for
  // accessory children (Floodlight / Siren / PIR under a camera). The
  // query is gated on parentDeviceId so non-accessory devices skip the
  // RPC entirely.
  const parentDeviceId = typeof device?.parentDeviceId === 'number' ? device.parentDeviceId : null
  const { data: parentDevice } = useDeviceManagerGetDevice(
    { deviceId: parentDeviceId ?? 0 },
    { enabled: parentDeviceId !== null },
  )
  const pendingDevice: DeviceNameFields = {
    id: Number.isFinite(deviceId) ? deviceId : 0,
    name: storedName,
    type: 'unknown',
    stableId: '',
    parentDeviceId: null,
  }
  const name = useDeviceLabel(device ?? pendingDevice, 'full')
  const parentLabel = useDeviceLabel(parentDevice ?? pendingDevice, 'full')
  const isMobile = useIsMobile()
  // Reflect the device's REAL enabled state (was hardcoded `true`, so the
  // Enable/Disable toggle never changed after a disable). `enable`/`disable`
  // invalidate the `deviceManager` query, so this re-derives on refetch.
  const isEnabled = device?.disabled !== true

  // Settings tabs are filtered per device type — non-camera devices
  // don't see Pipeline/Recording/Bindings (camera-only). Addon-
  // contributed top-tabs (discovered from the aggregate's
  // `location: 'top-tab'` sections) are appended unfiltered — an addon
  // decides which device types it serves. Built-in tabs always win on
  // an id collision (they come first in the dedup pass).
  // Config leaves the tab bar when the aggregate answered with nothing the
  // Config tab would render (Identity was removed; Export / top-tabs /
  // Extensions already live elsewhere). Pending keeps the tab (D315).
  const showConfigTab = useMemo(() => {
    const settingsSections = (aggregateData?.settings?.sections ?? []) as readonly ConfigSection[]
    const liveSections = (aggregateData?.live?.sections ?? []) as readonly ConfigSection[]
    return hasConfigTabContent(
      [...settingsSections, ...liveSections],
      deviceTypeStr,
      isAdmin,
      aggregateData !== undefined,
    )
  }, [aggregateData, deviceTypeStr, isAdmin])

  const tabs: readonly TabEntry[] = useMemo(() => {
    const seen = new Set<string>()
    const out: TabEntry[] = []
    // Order: structural < container's own addon tabs < primary-child promoted
    // tabs. The dedup keeps the FIRST entry for a given id, so the container's
    // own tab always wins a collision and a child tab only fills a gap.
    for (const t of [
      ...structuralTabsFor(deviceTypeStr, isAdmin),
      ...addonTabs,
      ...childAddonTabs,
    ]) {
      if (t.id === 'config' && !showConfigTab) continue
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push(t)
    }
    return out
  }, [deviceTypeStr, isAdmin, addonTabs, childAddonTabs, showConfigTab])

  // Effective active tab — the desired id from the URL if (and only if)
  // it's present in the available `tabs`, else 'overview'. We do NOT
  // rewrite the URL here: a desired id that isn't available YET (addon
  // top-tab still being discovered from the aggregate) stays in the URL
  // and applies the moment the tab appears, instead of being clobbered
  // to 'overview' on first paint.
  const activeTab: TabId = useMemo(
    () => resolveActiveDeviceTab(tabs, desiredTab),
    [tabs, desiredTab],
  )

  // Click handler — write the new tab to the URL (replace, so back/forward
  // isn't spammed) and drop any stale `sub` from the previous tab. The
  // inner sub-tab is tab-specific, so it must not bleed across tabs.
  const handleTabClick = useCallback(
    (tabId: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (tabId === 'overview') next.delete('tab')
          else next.set('tab', tabId)
          next.delete('sub')
          // The step matrix's `?step=&acc=` belong to one tab too.
          for (const key of STEP_INSPECTOR_PARAMS) next.delete(key)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // Inner sub-tab change — only meaningful for tabs that render an inner
  // TabbedSettingsForm (Config + addon top-tabs). Writes `?sub=` with
  // replace semantics.
  const handleSubTabChange = useCallback(
    (subId: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('sub', subId)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // Drives the Children section visibility in the Overview tab (`childrenData`
  // is resolved once above, near the primary-child tab promotion). Used to be
  // gated on `c.role` (accessory-only) — broadened to ANY child so hub-adopted
  // cameras under an NVR also surface here as a navigation list (DiscoveryPanel
  // covers the adopt/release lifecycle but operators want a clean nav list too).
  const hasAnyChildren = (childrenData ?? []).length > 0

  // Filter the common-panels tabs by feature. The strip is the four panels
  // in COMMON_SHORTCUTS (Logs, REPL, Events, State) and none of them carries a
  // `featureGate` today, so every device shows all four. The filter stays for
  // a panel that is only meaningful on some devices — PTZ and Intercom are NOT
  // such panels: PTZ is an aggregate-driven top-tab, Intercom a player button.
  const visibleShortcuts = useMemo(
    () =>
      COMMON_SHORTCUTS.filter(
        ({ featureGate }) => !featureGate || capabilities.includes(featureGate),
      ),
    [capabilities],
  )

  // The integration this device BELONGS to — the one rule
  // (`resolveDeviceIntegration`): its `integrationId` first, its `addonId`
  // (the SERVING addon, `provider`) only for legacy rows. Asking
  // `integrations.getByAddonId(provider)` filed a composed device (served by
  // `composer`, created by "Blocks", D659) under no integration at all.
  // `integrations.list` is the same shared cache entry the Devices page reads.
  const { data: integrations } = useIntegrationsList(undefined)
  const integrationResolution = useMemo(
    () => (device ? resolveDeviceIntegration(device, integrations) : null),
    [device, integrations],
  )
  const integration =
    integrationResolution?.kind === 'resolved' ? integrationResolution.integration : null
  // Unknown is rendered as unknown (D315), and an orphan is named as missing:
  // neither state borrows the serving addon's identity and calls it the
  // integration. A resolved legacy row still gets here through the helper's
  // addonId fallback.
  const integrationBreadcrumbLabel =
    integration !== null
      ? integration.name
      : integrationResolution?.kind === 'unknown'
        ? t('deviceDetail.loadingIntegration')
        : integrationResolution?.kind === 'orphan'
          ? t('deviceDetail.missingIntegration')
          : t('deviceDetail.noIntegration')
  // "Restart addon" restarts the SERVING addon (`provider`). Name it by the
  // integration only when that integration IS the serving addon — a composed
  // device's restart bounces `composer`, not "Blocks".
  const servingAddonLabel =
    integration !== null && integration.addonId === provider ? integration.name : provider

  const deleteMutation = useDeviceManagerRemove({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
      navigate(
        integration?.id
          ? integrationDetailUrl(integration.addonId, integration.id)
          : '/integrations',
      )
    },
  })

  const enableMutation = useDeviceManagerEnable({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })
  const disableMutation = useDeviceManagerDisable({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })
  // Reboot the camera firmware via the device-scoped `reboot` cap.
  // Provider implementations forward to the vendor protocol (Reolink
  // Baichuan cmd_id 23, ONVIF SystemReboot, ...) and resolve once the
  // remote ACKs — the device-online indicator drives the UI state.
  const rebootMutation = useRebootReboot()
  // Restart the addon backing this device — kernel-level lifecycle
  // op exposed as `addons.restartAddon`. Used both here and on the
  // Integration page, since one addon backs many devices.
  const restartAddonMutation = useAddonsRestartAddon({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })
  const canReboot = capabilities.includes(DeviceFeature.Rebootable)
  const isBatteryOperated = capabilities.includes(DeviceFeature.BatteryOperated)
  // Battery status — only fetched for cams that advertise battery
  // operation. Hook gates the underlying query on a numeric deviceId.
  const batteryStatus = useDeviceBattery(
    system.trpcClient,
    isBatteryOperated && isValidDeviceId ? deviceId : null,
  )
  // The device's own link (medium + signal). No feature flag: a device
  // without the cap has no slice and the badge renders nothing.
  const networkLink = useDeviceNetworkLink(system.trpcClient, isValidDeviceId ? deviceId : null)
  const runningSlice = useDeviceState(
    system.trpcClient,
    isValidDeviceId ? deviceId : null,
    (s) => s.runningState,
  )
  const runningBadge =
    runningSlice === undefined || runningSlice.running === null ? null : runningSlice.running
  const TypeIcon = deviceTypeMetaOf(deviceTypeStr ?? 'unknown', uiText).icon

  /**
   * Manual snapshot helper — fetched on demand from the kebab menu.
   * Invalidates the wrapper cache, pulls a fresh frame, and triggers a
   * browser download. No state retained between invocations beyond an
   * "in flight" guard so the menu can disable the item while running.
   */
  const [snapshotInFlight, setSnapshotInFlight] = useState(false)
  /**
   * Save a fresh still.
   *
   * Through the snapshot MEDIA plane, not `snapshot.getSnapshot`. The cap
   * returns `{base64, contentType}` — a full-resolution JPEG inflated 33 % and
   * carried whole through hub-main's event loop — to produce a `data:` URL that
   * is handed straight back to the browser as a file. The plane serves the same
   * bytes over HTTP, and `?force=1` is the wrapper's own freshness bypass, so
   * the explicit `invalidateCache` round-trip before it is no longer needed
   * either: two RPCs and a base64 payload become one authenticated GET.
   *
   * `authedDownload` (not a bare `<a download>`) because the plane is
   * `access: 'authenticated'` and a download anchor cannot carry a Bearer.
   */
  const handleSnapshot = async () => {
    if (snapshotInFlight) return
    setSnapshotInFlight(true)
    try {
      const safeName = name.replace(/[^a-zA-Z0-9_.-]+/g, '_')
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      await authedDownload(
        `${SNAPSHOT_MEDIA_PATH}/${String(deviceId)}.jpg?force=1`,
        `${safeName}-${ts}.jpg`,
      )
    } finally {
      setSnapshotInFlight(false)
    }
  }
  const toggleEnabledIsPending = enableMutation.isPending || disableMutation.isPending

  const { data: cameraAssignment } = usePipelineOrchestratorGetPipelineAssignment(
    { deviceId },
    {
      enabled: isValidDeviceId && isCamera,
      refetchInterval: 10_000,
    },
  )

  // Same sanity check the OverviewTab applies: the orchestrator
  // occasionally returns a cap-provider id (`addon:pipeline-runner`) as
  // the assignment's agentNodeId instead of a real cluster node. Routing
  // a metrics poll to that phantom node returns PRECONDITION_FAILED
  // every 3s. Skip the nodeId entirely when it looks like a provider id
  // so the cap router falls back to the local runner.
  const assignedHeaderNodeId = cameraAssignment?.agentNodeId ?? null
  const isHeaderRealNodeId =
    typeof assignedHeaderNodeId === 'string' &&
    assignedHeaderNodeId.length > 0 &&
    !assignedHeaderNodeId.startsWith('addon:')
  const headerRoutingNodeId = isHeaderRealNodeId ? assignedHeaderNodeId : undefined

  const { data: detectionMetrics } = usePipelineRunnerGetCameraMetrics(
    {
      deviceId,
      ...(headerRoutingNodeId ? { nodeId: headerRoutingNodeId } : {}),
    },
    {
      enabled: isValidDeviceId && isCamera,
      refetchInterval: 3_000,
      retry: false,
    },
  )

  // Live audio level for the header strip. Polled like the pipeline metrics;
  // null until a snapshot exists (no audio analysis for this device yet).
  // Cameras only — a climate or switch has no audio snapshot, and the query
  // otherwise warns on every poll.
  const { data: audioSnapshot } = useAudioMetricsGetCurrentSnapshot(
    { deviceId },
    {
      enabled: isValidDeviceId && isCamera,
      refetchInterval: 3_000,
      retry: false,
    },
  )
  const headerDbfs = audioSnapshot?.level?.dbfs ?? null

  function renderTabContent() {
    if (!isValidDeviceId) return null

    switch (activeTab) {
      case 'overview':
        return <OverviewTab device={device ?? {}} />
      case 'config':
        return (
          <ConfigTab
            deviceId={deviceId}
            activeSubTab={desiredSub}
            onSubTabChange={handleSubTabChange}
            deviceType={deviceTypeStr}
            isAdmin={isAdmin}
          />
        )
      case 'detection-pipeline':
        // One tab bar: Steps, then the contributed settings groups (zones /
        // detector / tracking / motion / stationary / audio / cluster). The
        // addon-contributed `detection-pipeline` / `zones` top-tab sections
        // render inside it, so this case supersedes the default branch below
        // for this tab id.
        return (
          <DetectionPipelineTab
            deviceId={deviceId}
            activeSubTab={desiredSub}
            onSubTabChange={handleSubTabChange}
          />
        )
      case 'bindings':
        return <BindingsTab deviceId={deviceId} />
      case HISTORY_TAB_ID:
        return <DeviceHistoryView deviceId={deviceId} onNavigate={(path) => navigate(path)} />
      case CUSTOMIZE_TAB_ID:
        return <CustomizeTab deviceId={deviceId} />
      default: {
        const tabId = activeTab

        // Addon-contributed top tab — render every section in the
        // aggregate that targets this tab id with `location: 'top-tab'`.
        // Multiple addons can land on the same tab (e.g. orchestrator
        // geometry CRUD + motion-wasm rules + detection-pipeline rules
        // all on `tab: 'zones'`); the form aggregator stacks them in
        // `order` sequence inside the same tab body.
        // A top-tab is either the container's own (render against the
        // container) or one promoted from the primary child (render against the
        // child's aggregate — e.g. a vacuum's Consumables on its container).
        const isAddonTab = addonTabs.some((t) => t.id === tabId)
        const childTab = childAddonTabs.find((t) => t.id === tabId)
        if (!isAddonTab && childTab === undefined) return null
        const targetDeviceId = childTab?.childDeviceId ?? deviceId
        if (tabId === DEVICE_EXPORT_TAB_ID) {
          // Export sections default to `location: 'settings'` (the cap
          // doesn't tag them as top-tab), so the standard top-tab filter
          // misses them. `isDeviceExportSection` is the ONE predicate that
          // decides export placement — the same call decides the tab's
          // existence above and its exclusion from Config in
          // `DeviceAggregateSection`, so the three can never disagree.
          // Stable section ordering (sort by `section.id` ascending) is
          // applied by the wrapper inside DeviceAggregateSection.
          return (
            <DeviceAggregateSection
              deviceId={deviceId}
              sectionFilter={isDeviceExportSection}
              activeSubTab={desiredSub}
              onSubTabChange={handleSubTabChange}
            />
          )
        }
        const section = (
          <DeviceAggregateSection
            deviceId={targetDeviceId}
            sectionFilter={(s) => s.location === 'top-tab' && s.tab === tabId}
            activeSubTab={desiredSub}
            onSubTabChange={handleSubTabChange}
          />
        )
        // A tab promoted from the primary child must render its embedded
        // host-widgets (e.g. the Consumables panel) against the CHILD's device,
        // not the container's. Those widgets read `useDeviceId()` from context,
        // not the section's `deviceId` prop, so override the context here —
        // otherwise the widget queries the container (#3) and shows
        // "no consumables reported" while the child (#4) has the data.
        if (childTab !== undefined && targetDeviceId !== deviceId) {
          return <DeviceContextProvider deviceId={targetDeviceId}>{section}</DeviceContextProvider>
        }
        return section
      }
    }
  }

  // --- Invalid URL param ---
  if (!isValidDeviceId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-foreground-subtle">
        <p className="text-lg font-semibold text-foreground">
          {t('deviceDetail.invalidDeviceId', 'Invalid device id')}
        </p>
        <p className="text-xs">
          <Trans
            i18nKey="deviceDetail.invalidSegment"
            values={{ segment: params.deviceId }}
            components={{
              code: <code className="font-mono bg-surface px-1.5 py-0.5 rounded text-[11px]" />,
            }}
          />
        </p>
        <Button
          variant="unstyled"
          onClick={() => navigate('/integrations')}
          className="mt-2 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {t('deviceDetail.backToIntegrations', 'Back to Integrations')}
        </Button>
      </div>
    )
  }

  // --- Loading skeleton ---
  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="border-b border-border bg-surface px-6 py-4">
          <div className="h-4 w-48 rounded bg-surface-hover animate-pulse mb-3" />
          <div className="h-8 w-64 rounded bg-surface-hover animate-pulse" />
        </div>
        <div className="flex-1 p-6">
          <div className="h-40 rounded-lg border border-border bg-surface animate-pulse" />
        </div>
      </div>
    )
  }

  // --- Device not found ---
  if (isError || !deviceData) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-foreground-subtle">
        <p className="text-lg font-semibold text-foreground">
          {t('deviceDetail.deviceNotFound', 'Device not found')}
        </p>
        <p className="text-xs">
          <Trans
            i18nKey="deviceDetail.noDeviceWithId"
            values={{ id: deviceId }}
            components={{
              code: <code className="font-mono bg-surface px-1.5 py-0.5 rounded text-[11px]" />,
            }}
          />
        </p>
        <Button
          variant="unstyled"
          onClick={() => navigate('/integrations')}
          className="mt-2 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {t('deviceDetail.backToIntegrations', 'Back to Integrations')}
        </Button>
      </div>
    )
  }

  return (
    // `overflow-clip`, NOT `overflow-hidden`. They clip identically, but
    // `hidden` makes this a SCROLL CONTAINER — and a scroll container with no
    // scrollbar can still be scrolled PROGRAMMATICALLY, which the browser does
    // on its own whenever focus lands on a descendant that is out of its view.
    // There is then no way back: no scrollbar, no wheel target, nothing.
    //
    // Measured live on camera 106 (2026-09-14): clicking an option in the
    // Detection-sources picker focused its visually-hidden `<input class=
    // "sr-only">` — absolutely positioned, bottom at 1 340 px, which is
    // exactly this element's `scrollHeight` — and the browser scrolled THIS
    // div to `scrollTop: 618`. The whole page rose 618 px and left white space
    // below it, permanently, which is the operator's report word for word:
    // "il contenuto sale verso l'alto lasciando spazio bianco in basso".
    // [In English: "the content rises upward leaving white space below".]
    // Setting `scrollTop = 0` by hand restored it, which is what pinned it
    // here rather than on the save bar or the tab machinery.
    //
    // `clip` is not a scroll container, so the browser cannot scroll it and
    // takes the inner `overflow-y-auto` settings body instead — which is the
    // one that has a scrollbar and can be scrolled back. It also leaves
    // `position: sticky` working for descendants, which `hidden` silently
    // disables.
    //
    // FOURTH instance of this exact trap here — see AdminPage (`overflow-x-clip`
    // on the page frame), NodeCard and SchemaTabBar.
    <div className="absolute inset-0 flex flex-col overflow-clip">
      {/* ── Header ── */}
      <div className="border-b border-border bg-surface px-6 py-3 flex-shrink-0">
        {/* Row 1: breadcrumb only — actions live with the device-info
            row below so a long breadcrumb chain can't collide with a
            growing toolbar. */}
        <div className="mb-2">
          <Breadcrumb
            items={[
              {
                label: t('deviceDetail.integrations', 'Integrations'),
                onClick: () => navigate('/integrations'),
              },
              integration !== null
                ? {
                    label: integrationBreadcrumbLabel,
                    onClick: () =>
                      navigate(integrationDetailUrl(integration.addonId, integration.id)),
                  }
                : { label: integrationBreadcrumbLabel },
              { label: name },
            ]}
          />
        </div>

        {/* Row 2: device info on the left, actions on the right.
            Action layout (left → right):
              1. Enable/Disable toggle (primary, high-frequency).
              2. Panel toggles (live stream / logs / events / REPL).
              3. Kebab menu (Snapshot / Reboot / Restart addon / Delete).
            Secondary actions stay collapsed in the kebab so the toolbar
            scales as more device-scoped operations land. */}
        <div className="flex items-center gap-2 sm:gap-3">
          {integration !== null && (
            <IntegrationLogoLink
              provider={integration.addonId}
              integrationId={integration.id}
              name={integration.name}
            />
          )}
          <RunningBadge running={runningBadge}>
            <TypeIcon className="h-5 w-5 text-foreground-subtle shrink-0" aria-hidden />
          </RunningBadge>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-sm sm:text-base font-semibold text-foreground truncate">
                {name}
              </h1>
              <StatusBadge status={status} />
              {isBatteryOperated && <BatteryBadge status={batteryStatus} variant="full" />}
              <NetworkLinkBadge status={networkLink} />
            </div>
            {/* Parent-device link — accessory children (Floodlight /
                Siren / PIR / etc.) carry a parentDeviceId; surface a
                one-click jump back so operators don't have to navigate
                via the integrations list. Hidden when no parent or
                when the parent record hasn't loaded yet (avoid a
                flash of an unlabeled link). */}
            {parentDeviceId !== null && parentDevice && (
              <Button
                variant="unstyled"
                type="button"
                onClick={() => navigate(`/devices/${parentDeviceId}`)}
                className="text-[10px] text-foreground-subtle hover:text-primary transition-colors mt-0.5 inline-flex items-center gap-1"
                title={t('deviceDetail.openParentDevice', 'Open parent device {{name}}', {
                  name: parentLabel,
                })}
              >
                <span>↑</span>
                <span className="truncate">{parentLabel}</span>
              </Button>
            )}
            {/* Capability icons hidden on small viewports to keep the
                title row from wrapping. The CapabilityBadges set is
                already in compact icon form, but on phones it still
                eats space we'd rather give to the title + toolbar. */}
            <div className="hidden md:flex items-center gap-3 mt-0.5 text-[10px] text-foreground-subtle">
              {capabilities.length > 0 && <CapabilityBadges capabilities={capabilities} />}
            </div>
          </div>

          {/* Live detection stats — full bar on lg+, collapses to a
              single phase dot on smaller screens (raw stats live in
              the stream-panel kebab now). */}
          {detectionMetrics && (
            <div className="hidden lg:flex">
              <DetectionStatsBar metrics={detectionMetrics} dbfs={headerDbfs} />
            </div>
          )}

          {/* ── Action toolbar ── */}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="unstyled"
              onClick={async () => {
                if (isEnabled) {
                  const confirmed = await confirm({
                    title: t('deviceDetail.disable', 'Disable "{{name}}"?', { name }),
                    message: t(
                      'deviceDetail.theDeviceWillStopProcessing',
                      'The device will stop processing streams and events. You can re-enable it later.',
                    ),
                    confirmLabel: t('common.disable', 'Disable'),
                    variant: 'danger',
                  })
                  if (confirmed) disableMutation.mutate({ deviceId })
                } else {
                  enableMutation.mutate({ deviceId })
                }
              }}
              disabled={toggleEnabledIsPending}
              title={
                isEnabled
                  ? t('deviceDetail.disableDevice', 'Disable device')
                  : t('deviceDetail.enableDevice', 'Enable device')
              }
              className={`inline-flex items-center gap-1.5 rounded-lg px-2 sm:px-2.5 py-1.5 text-[11px] font-medium border transition-colors disabled:opacity-50 ${
                isEnabled
                  ? 'border-success/30 text-success hover:bg-success/10'
                  : 'border-border text-foreground-subtle/50 hover:text-foreground hover:bg-surface-hover'
              }`}
            >
              <Power className="h-3.5 w-3.5" />
              {/* Label hides on phones — icon + color is enough. */}
              <span className="hidden sm:inline">
                {toggleEnabledIsPending
                  ? t('deviceDetail.updating', 'Updating…')
                  : isEnabled
                    ? t('deviceDetail.enabled', 'Enabled')
                    : t('deviceDetail.disabled', 'Disabled')}
              </span>
            </Button>

            <div className="hidden sm:block h-5 w-px bg-border mx-1" />

            {/* The three per-camera FUNCTION switches, next to the device's own
                Enable/Disable because they answer the same question one level
                down: what is this camera doing right now. Each one reads and
                writes the authority that already owns it (D113) — there is no
                aggregate behind them and nothing is stored here. */}
            {isCamera && (
              <>
                <CameraFunctionSwitches deviceId={deviceId} />
                <div className="hidden sm:block h-5 w-px bg-border mx-1" />
              </>
            )}

            {/* The device's own configuration page, when it has one. Ahead of
                the kebab because it OPENS something; the kebab hides choices.
                Self-gating — nothing renders for a device with no page, and
                nothing renders a disabled button (D62). */}
            <DeviceAdminLinkButton deviceId={deviceId} />

            {/* Header shortcut icons removed: the common-panels live as
                an always-visible tab block under the hero (left column
                on desktop/tablet, stacked on mobile). The header keeps
                only Enable/Disable + the kebab so it scales for every
                device type without growing horizontally. */}

            <KebabMenu
              triggerClassName="ml-1"
              items={
                [
                  {
                    id: 'snapshot',
                    label: t('deviceDetail.takeSnapshot', 'Take snapshot'),
                    description: t(
                      'deviceDetail.fetchAFreshFrameAnd',
                      'Fetch a fresh frame and download it.',
                    ),
                    icon: Camera,
                    disabled: snapshotInFlight,
                    onClick: () => {
                      void handleSnapshot()
                    },
                  },
                  {
                    id: 'reboot',
                    label: t('deviceDetail.rebootDevice', 'Reboot device'),
                    description: t(
                      'deviceDetail.cameraGoesOfflineFor30',
                      'Camera goes offline for ~30 seconds.',
                    ),
                    icon: RotateCw,
                    hidden: !canReboot,
                    disabled: rebootMutation.isPending,
                    danger: true,
                    onClick: async () => {
                      const confirmed = await confirm({
                        title: t('deviceDetail.reboot', 'Reboot "{{name}}"?', { name }),
                        message: t(
                          'deviceDetail.theCameraWillGoOffline',
                          'The camera will go offline for around 30 seconds while the firmware reboots.',
                        ),
                        confirmLabel: t('deviceDetail.reboot2', 'Reboot'),
                        variant: 'danger',
                      })
                      if (confirmed) rebootMutation.mutate({ deviceId })
                    },
                  },
                  {
                    id: 'restart-addon',
                    label: t('deviceDetail.restartAddon', 'Restart addon'),
                    description: t(
                      'deviceDetail.bouncesEveryDeviceServedBy',
                      'Bounces every device served by {{servingAddonLabel}}.',
                      { servingAddonLabel },
                    ),
                    icon: RefreshCw,
                    disabled: restartAddonMutation.isPending,
                    danger: true,
                    onClick: async () => {
                      const confirmed = await confirm({
                        title: t('deviceDetail.restart', 'Restart "{{servingAddonLabel}}"?', {
                          servingAddonLabel,
                        }),
                        message: t(
                          'deviceDetail.restartingTheAddonWillBriefly',
                          'Restarting the addon will briefly disconnect every device served by it (not just "{{name}}"). Streams will reconnect automatically.',
                          { name },
                        ),
                        confirmLabel: t('deviceDetail.restart2', 'Restart'),
                        variant: 'danger',
                      })
                      if (confirmed) restartAddonMutation.mutate({ addonId: provider })
                    },
                  },
                  {
                    id: 'delete',
                    label: t('deviceDetail.deleteDevice', 'Delete device'),
                    description: t(
                      'deviceDetail.removeTheDeviceAndAll',
                      'Remove the device and all its settings.',
                    ),
                    icon: Trash2,
                    separatorBefore: true,
                    disabled: deleteMutation.isPending,
                    danger: true,
                    onClick: async () => {
                      const confirmed = await confirm({
                        title: t('deviceDetail.delete', 'Delete "{{name}}"?', { name }),
                        message: t(
                          'deviceDetail.thisWillRemoveTheDevice',
                          'This will remove the device and all its settings. This action cannot be undone.',
                        ),
                        confirmLabel: t('common.delete', 'Delete'),
                        variant: 'danger',
                      })
                      if (confirmed) deleteMutation.mutate({ deviceId })
                    },
                  },
                ] as readonly KebabMenuItem[]
              }
            />
          </div>
        </div>
      </div>

      {/* ── Main 2-col fixed-height layout ──
          Desktop ≥ 1024px: left 1/3, right 2/3.
          Tablet 768-1023px: left 1/2, right 1/2.
          Mobile <768px: stacked (stream → common-panels → settings),
          page becomes scrollable.

          The whole `<main>` takes the remaining viewport height
          (`flex-1 min-h-0 overflow-hidden`) so each column scrolls its
          OWN content (left = common-panels content; right = settings
          tab content). On mobile the constraint relaxes — `min-h-0`
          stays but the parent allows scroll via overflow-y-auto. */}
      <DeviceContextProvider deviceId={deviceId} device={device ?? undefined}>
        <VodPlaybackProvider>
          <RecordedPlaybackProvider>
            <PlayerOverlaysProvider>
              <ZoneEditingProvider>
                <main
                  className={
                    isMobile
                      ? 'flex-1 overflow-y-auto flex flex-col'
                      : 'flex-1 min-h-0 overflow-hidden flex flex-row'
                  }
                >
                  {/* ── LEFT COLUMN ──
              One unified card: stream + tab strip + content share a
              single border-and-rounded chrome so the inner dividers
              are the only visible separation. The right column is
              partitioned by its own border-l, so this column doesn't
              need a border-r.

              Width: responsive default `w-1/2 lg:w-1/3` until the user
              drags the divider, then `leftColWidthPx` takes over via
              inline style (overrides the Tailwind width). Mobile is
              stacked so width is irrelevant. */}
                  <div
                    className={
                      isMobile
                        ? 'flex flex-col bg-surface'
                        : `${leftColWidthPx === null ? 'w-1/2 lg:w-1/3' : ''} flex-shrink-0 flex flex-col bg-surface min-h-0 overflow-y-auto`
                    }
                    style={
                      !isMobile && leftColWidthPx !== null
                        ? { width: `${String(leftColWidthPx)}px` }
                        : undefined
                    }
                  >
                    {/* Stream / device-specific hero (row 1) — the camera slot
                sizes to content (NOT a fixed `aspect-video`). `StreamPanel`
                already renders its OWN `aspect-video` video box, ABOVE a
                header bar; pinning this outer slot to 16:9 too made the
                content (header + 16:9 video) overflow the 16:9 slot, and
                StreamPanel's `overflow-hidden` clipped the bottom of the
                video — hiding the in-video toolbar (mute/fullscreen),
                worst on mobile where the header wraps to two rows. Letting
                the slot size to content keeps the video at a sensible 16:9
                (StreamPanel's inner constraint) while the toolbar stays
                visible. Camera keeps `bg-black` (off-pixels during startup);
                other types use `bg-surface` to match the app chrome. */}
                    <div
                      className={
                        isCamera
                          ? 'flex-shrink-0 border-b border-border-subtle bg-black'
                          : isMobile
                            ? // Mobile stacks the columns; the whole <main> scrolls,
                              // so the hero keeps its natural height here.
                              'flex-shrink-0 border-b border-border-subtle bg-surface'
                            : // Desktop: the slot GROWS to fit the hero and the
                              // widgets under it (the Consumables section, D915) —
                              // a cap clipped them behind the tab block. The tab
                              // block below keeps a minimum height; when the two do
                              // not fit, the column itself scrolls.
                              'shrink-0 border-b border-border-subtle bg-surface'
                      }
                    >
                      {isCamera ? (
                        <StreamPanelContent
                          deviceId={deviceId}
                          intercomAvailable={capabilities.includes(DeviceFeature.TwoWayAudio)}
                        />
                      ) : (
                        // A plain wrapper: the hero's `h-full` must not resolve
                        // against the slot, or it claims the widgets' height too.
                        <div>
                          <DeviceHero
                            deviceId={deviceId}
                            deviceName={name}
                            deviceType={deviceTypeStr ?? 'unknown'}
                            provider={provider}
                            isOnline={isOnline}
                            features={capabilities}
                          />
                          {/* The hero block's own sections (D915): consumables
                              sit right under the hero card, in the same slot, so
                              they are in view on every tab. */}
                          <DeviceHeroWidgets deviceId={deviceId} widgets={heroSectionWidgets} />
                        </div>
                      )}
                    </div>
                    {/* A camera's slot is the black stream frame; its hero
                        widgets follow it on the surface colour. */}
                    {isCamera && heroSectionWidgets.length > 0 && (
                      <div className="flex-shrink-0 border-b border-border-subtle bg-surface pt-3 sm:pt-4">
                        <DeviceHeroWidgets deviceId={deviceId} widgets={heroSectionWidgets} />
                      </div>
                    )}

                    {/* Common-panels tab block (row 2). Tab strip is the
                navigation, body is the active shortcut's content.
                Default = logs. Right border partitions from settings
                column on desktop. */}
                    <div
                      className={
                        isMobile
                          ? 'flex flex-col border-b border-border'
                          : 'flex-1 min-h-64 flex flex-col overflow-hidden'
                      }
                    >
                      <div className="flex-shrink-0 border-b border-border-subtle px-2 py-1.5">
                        <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-0.5">
                          {visibleShortcuts.map(({ id, labelKey, icon: Icon }) => {
                            const active = activeShortcut === id
                            return (
                              <Button
                                variant="unstyled"
                                key={id}
                                onClick={() => setActiveShortcut(id)}
                                title={t(labelKey)}
                                className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors flex-shrink-0 ${
                                  active
                                    ? 'bg-primary/15 text-primary'
                                    : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover'
                                }`}
                              >
                                <Icon className="h-3 w-3" />
                                {t(labelKey)}
                              </Button>
                            )
                          })}
                        </div>
                      </div>
                      <div
                        className={
                          isMobile ? 'h-72 overflow-hidden' : 'flex-1 min-h-0 overflow-hidden'
                        }
                      >
                        {activeShortcut === 'logs' && (
                          <LogsPanelContent
                            deviceId={deviceId}
                            containerDeviceId={deviceTypeStr === 'container' ? deviceId : undefined}
                          />
                        )}
                        {activeShortcut === 'repl' && <ReplPanelContent deviceId={deviceId} />}
                        {activeShortcut === 'events' && <EventsPanelContent deviceId={deviceId} />}
                        {activeShortcut === 'state' && <StatePanelContent deviceId={deviceId} />}
                      </div>
                    </div>
                  </div>

                  {/* ── DIVIDER — drag to resize the left column. Desktop /
              tablet only; mobile stacks the two columns vertically
              so a horizontal grip would have no meaning. */}
                  {!isMobile && (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      title={t('deviceDetail.dragToResize', 'Drag to resize')}
                      onMouseDown={startResizingLeftCol}
                      className="flex-shrink-0 w-1 cursor-col-resize bg-border hover:bg-primary/40 transition-colors group relative z-10"
                    >
                      {/* Wider invisible hit-target so the grip is easier to
                  catch — actual visual stays at 4px. */}
                      <span className="absolute inset-y-0 -left-1 -right-1" />
                    </div>
                  )}

                  {/* ── RIGHT COLUMN — settings tabs + content ── */}
                  <div
                    className={
                      isMobile
                        ? // Grows to the bottom of <main>, so a short tab fills the
                          // viewport and its Save footer rests on the last row.
                          'flex flex-1 flex-col'
                        : 'flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden'
                    }
                  >
                    {/* Tab bar */}
                    <div className="flex-shrink-0 border-b border-border bg-surface px-4">
                      <div className="flex flex-nowrap overflow-x-auto md:flex-wrap md:overflow-x-visible items-center gap-0">
                        {tabs.map((tab) => {
                          const isActive = activeTab === tab.id
                          return (
                            <Button
                              variant="unstyled"
                              key={tab.id}
                              onClick={() => handleTabClick(tab.id)}
                              className={`relative flex-shrink-0 px-3 py-2 text-xs font-medium transition-colors ${
                                isActive
                                  ? 'text-primary'
                                  : 'text-foreground-subtle hover:text-foreground'
                              }`}
                            >
                              {tab.label}
                              {isActive && (
                                <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-primary" />
                              )}
                            </Button>
                          )
                        })}
                      </div>
                    </div>

                    {/* Tab content area — scrolls independently on desktop;
                Children list (when applicable) is injected at the top
                of the Overview tab so accessory parents have a single
                discoverable surface for nav. */}
                    <div
                      className={
                        isMobile
                          ? 'p-3 flex flex-1 flex-col gap-3'
                          : 'flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3'
                      }
                    >
                      {activeTab === 'overview' && hasAnyChildren && (
                        <ChildrenList parentDeviceId={deviceId} />
                      )}
                      {renderTabContent()}
                    </div>
                  </div>
                </main>
              </ZoneEditingProvider>
            </PlayerOverlaysProvider>
          </RecordedPlaybackProvider>
        </VodPlaybackProvider>
      </DeviceContextProvider>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detection stats bar — shown in the header, always visible
// ---------------------------------------------------------------------------

function DetectionStatsBar({
  metrics,
  dbfs,
}: {
  readonly metrics: {
    phase?: string
    actualFps?: number
    avgInferenceTimeMs?: number
    queueDepth?: number
  }
  readonly dbfs?: number | null
}) {
  const uiText = useUiText()
  const { t } = useTranslation()
  const phase = metrics.phase ?? 'idle'
  const phaseCfg = getPhaseVisual(phase, uiText)

  return (
    <div className="flex items-center gap-3 flex-shrink-0">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${phaseCfg.dotClass}`} />
        <span className={`text-[10px] font-medium ${phaseCfg.textColor}`}>{phaseCfg.label}</span>
      </div>
      <div className="h-3 w-px bg-border" />
      <div className="flex items-center gap-1 text-[10px] text-foreground-subtle">
        <Activity className="h-3 w-3" />
        <span className="text-foreground tabular-nums">{(metrics.actualFps ?? 0).toFixed(1)}</span>
        <span>{t('common.fpsWord')}</span>
      </div>
      <div className="flex items-center gap-1 text-[10px] text-foreground-subtle">
        <Cpu className="h-3 w-3" />
        <span className="text-foreground tabular-nums">
          {(metrics.avgInferenceTimeMs ?? 0).toFixed(0)}
        </span>
        <span>ms</span>
      </div>
      <div
        className="flex items-center gap-1 text-[10px] text-foreground-subtle"
        title={t('deviceDetail.currentAudioLevelDbfs', 'Current audio level (dBFS)')}
      >
        <Volume2 className="h-3 w-3" />
        <span className="text-foreground tabular-nums">
          {dbfs === null || dbfs === undefined ? '—' : dbfs.toFixed(0)}
        </span>
        <span>dB</span>
      </div>
      {(metrics.queueDepth ?? 0) > 0 && (
        <span className="text-[10px] text-warning tabular-nums">q:{metrics.queueDepth}</span>
      )}
    </div>
  )
}
