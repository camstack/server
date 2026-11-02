/**
 * Connectivity — external systems this hub talks to, one kind at a time
 * (Exporters / Email / Brokers / Calendars) under the OSD `SectionedPage`
 * shell, then one integration at a time via an embedded `<IntegrationHub>`.
 *
 * Membership is codegen'd (`connectivity-model.ts` + `CAP_PROVIDER_KIND_MAP`),
 * never a hand list of addon ids. An addon that declares two provider kinds
 * (e.g. google-services: calendar-source + smtp-provider) appears in both
 * sections.
 *
 * URL: `?tab=<exporters|email|brokers|calendars>` selects the kind section;
 * `?integration=<addonId>&section=<settings|activity|…>` selects the body
 * (cleared when leaving a kind via `ownedParams`).
 */
import {
  Calendar,
  Mail,
  MonitorSmartphone,
  Plug,
  Radio,
  Share2,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Badge,
  DeviceExportPanel,
  DeviceExportSetup,
  useAddonsList,
  useBrokerGetStatus,
  useDeviceExportGetStatus,
} from '@camstack/ui-library'
import {
  BrokerRegistryStatusSchema,
  CAP_PROVIDER_KIND_MAP,
  DeviceExportStatusSchema,
} from '@camstack/types'
import type { ProviderKind } from '@camstack/types'

import { AdminSectionedPage } from '../../components/AdminSectionedPage'
import {
  AddonIntegrationBody,
  type IntegrationPanel,
} from '../../components/integration-hub/AddonIntegrationBody'
import { STATUS_BADGE_CLASS } from '../../components/integration-hub/addon-controls'
import { IntegrationHub } from '../../components/integration-hub/IntegrationHub'
import type { IntegrationGroup } from '../../components/integration-hub/types'
import { BrokerManager } from '../../components/brokers/BrokerManager'
import {
  type ConnectivitySectionId,
  INTEGRATION_HUB_OWNED_PARAMS,
} from '../../lib/integration-hub-url'
import { navChromeForPath } from '../../lib/nav-items'
import {
  capForRow,
  capsOfKind,
  processPillState,
  toConnectivityRow,
  type ConnectivityRow,
} from './connectivity-model'
import { WasteSettingsSources } from './WasteSettingsSources'
import i18n from '../../i18n/index'
import type { TFunction } from 'i18next'

const POLL_INTERVAL_MS = 10_000

interface KindDescriptor {
  readonly sectionId: ConnectivitySectionId
  readonly kind: ProviderKind
  readonly labelKey: string
  readonly icon: LucideIcon
  readonly installLabelKey: string
  readonly emptyTitleKey: string
  readonly emptyDescriptionKey: string
}

/**
 * Pre-SectionedPage Connectivity used `?tab=<ProviderKind>` as a group link.
 * Map those (and a few aliases) onto the new section ids.
 */
const LEGACY_TAB_TO_SECTION: Readonly<Record<string, ConnectivitySectionId>> = {
  'device-export': 'exporters',
  exporters: 'exporters',
  email: 'email',
  broker: 'brokers',
  brokers: 'brokers',
  'message-brokers': 'brokers',
  calendar: 'calendars',
  calendars: 'calendars',
  'calendar-source': 'calendars',
}

const KINDS: readonly KindDescriptor[] = [
  {
    sectionId: 'exporters',
    kind: 'device-export',
    labelKey: 'system.connectivity.exporters',
    icon: Share2,
    installLabelKey: 'system.connectivity.exportersInstall',
    emptyTitleKey: 'system.connectivity.exportersEmptyTitle',
    emptyDescriptionKey: 'system.connectivity.exportersEmptyDescription',
  },
  {
    sectionId: 'email',
    kind: 'email',
    labelKey: 'system.connectivity.email',
    icon: Mail,
    installLabelKey: 'system.connectivity.emailInstall',
    emptyTitleKey: 'system.connectivity.emailEmptyTitle',
    emptyDescriptionKey: 'system.connectivity.emailEmptyDescription',
  },
  {
    sectionId: 'brokers',
    kind: 'broker',
    labelKey: 'system.connectivity.brokers',
    icon: Radio,
    installLabelKey: 'system.connectivity.brokersInstall',
    emptyTitleKey: 'system.connectivity.brokersEmptyTitle',
    emptyDescriptionKey: 'system.connectivity.brokersEmptyDescription',
  },
  {
    sectionId: 'calendars',
    kind: 'calendar',
    labelKey: 'system.connectivity.calendars',
    icon: Calendar,
    installLabelKey: 'system.connectivity.calendarsInstall',
    emptyTitleKey: 'system.connectivity.calendarsEmptyTitle',
    emptyDescriptionKey: 'system.connectivity.calendarsEmptyDescription',
  },
]

function buildGroup(
  descriptor: KindDescriptor,
  rows: readonly ConnectivityRow[],
  navigate: (path: string) => void,
  t: TFunction,
): IntegrationGroup {
  const kindCaps = capsOfKind(CAP_PROVIDER_KIND_MAP, descriptor.kind)
  const entries = rows.flatMap((row) => {
    const capName = capForRow(row, kindCaps)
    if (capName === null) return []
    const pill = processPillState(row.processState)
    return [
      {
        id: row.addonId,
        name: row.displayName,
        fallbackIcon: descriptor.icon,
        state: pill.state,
        stateLabel: pill.label,
        render: () => (
          <AddonIntegrationBody
            addonId={row.addonId}
            displayName={row.displayName}
            capName={capName}
            isActive={row.processState === 'running'}
            badges={
              <>
                <ProcessBadge processState={row.processState} />
                <KindStatusBadge kind={descriptor.kind} addonId={row.addonId} />
              </>
            }
            lead={
              descriptor.kind === 'device-export' ? (
                <DeviceExportSetup addonId={row.addonId} />
              ) : undefined
            }
            panels={panelsFor(descriptor.kind, row.addonId, (id) => navigate(`/devices/${id}`))}
            settingsContent={
              row.addonId === 'waste-collections' ? (
                <WasteSettingsSources addonId={row.addonId} capName={capName} />
              ) : undefined
            }
          />
        ),
      },
    ]
  })
  return {
    id: descriptor.sectionId,
    label: t(descriptor.labelKey),
    entries,
    install: {
      capability: kindCaps[0] ?? descriptor.kind,
      label: t(descriptor.installLabelKey),
    },
  }
}

function ConnectivityKindHub({
  descriptor,
  rows,
  isLoading,
}: {
  readonly descriptor: KindDescriptor
  readonly rows: readonly ConnectivityRow[]
  readonly isLoading: boolean
}): ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const group = useMemo(
    () => buildGroup(descriptor, rows, navigate, t),
    [descriptor, rows, navigate, t],
  )

  return (
    <IntegrationHub
      embedded
      icon={descriptor.icon}
      title={t(descriptor.labelKey)}
      subtitle={null}
      groups={[group]}
      isLoading={isLoading}
      emptyTitle={t(descriptor.emptyTitleKey)}
      emptyDescription={t(descriptor.emptyDescriptionKey)}
    />
  )
}

export function IntegrationsPage(): ReactElement {
  const { t } = useTranslation()
  const addonsQuery = useAddonsList(undefined, {
    refetchInterval: POLL_INTERVAL_MS,
  })
  const [searchParams, setSearchParams] = useSearchParams()
  const chrome = navChromeForPath('/system/integrations', {
    t,
    isAdmin: true,
  }) ?? {
    icon: Plug,
    title: t('admin.system.integrations.connectivity', 'Connectivity'),
  }

  // Pre-SectionedPage Connectivity used `?tab=<ProviderKind>` as a group link.
  useEffect(() => {
    const raw = searchParams.get('tab')
    if (raw === null) return
    const mapped = LEGACY_TAB_TO_SECTION[raw]
    if (mapped === undefined || mapped === raw) return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('tab', mapped)
        return next
      },
      { replace: true },
    )
  }, [searchParams, setSearchParams])

  const rows = useMemo(
    () =>
      (addonsQuery.data ?? [])
        .map(toConnectivityRow)
        .filter((r): r is ConnectivityRow => r !== null),
    [addonsQuery.data],
  )

  const sections = useMemo(
    () =>
      KINDS.map((descriptor) => ({
        id: descriptor.sectionId,
        label: t(descriptor.labelKey),
        ownedParams: INTEGRATION_HUB_OWNED_PARAMS,
        content: (
          <ConnectivityKindHub
            descriptor={descriptor}
            rows={rows}
            isLoading={addonsQuery.isLoading}
          />
        ),
      })),
    [addonsQuery.isLoading, rows, t],
  )

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      subtitle={t(
        'admin.system.integrations.externalSystemsThisHubTalks',
        'External systems this hub talks to — exporters, email, brokers and calendar sources.',
      )}
      defaultSection="exporters"
      sectionsLabel="Connectivity sections"
      sections={sections}
    />
  )
}

/**
 * The panel a kind contributes. A broker's connections sit above the settings;
 * an exporter's devices table goes last (`placement: 'end'`). Email / calendars
 * have none beyond the shared settings + activity.
 */
function panelsFor(
  kind: ProviderKind,
  addonId: string,
  openDevice: (deviceId: string) => void,
): readonly IntegrationPanel[] {
  if (kind === 'device-export') {
    return [
      {
        id: 'devices',
        title: i18n.t('admin.system.integrations.devices', 'Devices'),
        icon: MonitorSmartphone,
        placement: 'end',
        content: (
          <DeviceExportPanel addonId={addonId} onOpenDevice={openDevice} showSetup={false} />
        ),
      },
    ]
  }
  if (kind === 'broker') {
    return [
      {
        id: 'connections',
        title: i18n.t('admin.system.integrations.connections', 'Connections'),
        icon: Radio,
        content: <BrokerManager addonId={addonId} />,
      },
    ]
  }
  return []
}

function ProcessBadge({ processState }: { readonly processState: string | null }): ReactElement {
  const { state, label } = processPillState(processState)
  const variant = state === 'ok' ? 'success' : state === 'error' ? 'danger' : 'default'
  return (
    <Badge variant={variant} className={`${STATUS_BADGE_CLASS} capitalize`}>
      {label}
    </Badge>
  )
}

function KindStatusBadge({
  kind,
  addonId,
}: {
  readonly kind: ProviderKind
  readonly addonId: string
}): ReactElement | null {
  if (kind === 'broker') return <BrokerStatusBadge addonId={addonId} />
  if (kind === 'device-export') return <DeviceExportStatusBadge addonId={addonId} />
  return null
}

function BrokerStatusBadge({ addonId }: { readonly addonId: string }): ReactElement | null {
  const { t } = useTranslation()
  const { data } = useBrokerGetStatus(
    { addonId },
    { refetchInterval: POLL_INTERVAL_MS, retry: false },
  )
  const parsed = BrokerRegistryStatusSchema.safeParse(data)
  if (!parsed.success) return null
  const { brokerCount, connectedCount } = parsed.data
  return (
    <Badge variant="info" className={STATUS_BADGE_CLASS}>
      {connectedCount > 0
        ? t('system.connectivity.connectionsConnected', {
            count: brokerCount,
            connected: connectedCount,
          })
        : t('system.connectivity.connections', { count: brokerCount })}
    </Badge>
  )
}

function DeviceExportStatusBadge({ addonId }: { readonly addonId: string }): ReactElement | null {
  const { t } = useTranslation()
  const { data } = useDeviceExportGetStatus(
    { addonId },
    { refetchInterval: POLL_INTERVAL_MS, retry: false },
  )
  const parsed = DeviceExportStatusSchema.safeParse(data)
  if (!parsed.success) return null
  const { linkState, exposedDeviceCount } = parsed.data
  const variant = linkState === 'linked' ? 'success' : linkState === 'error' ? 'danger' : 'default'
  return (
    <Badge variant={variant} className={STATUS_BADGE_CLASS}>
      {t('admin.system.integrations.exposed', '{{linkState}} · {{exposedDeviceCount}} exposed', {
        linkState,
        exposedDeviceCount,
      })}
    </Badge>
  )
}
