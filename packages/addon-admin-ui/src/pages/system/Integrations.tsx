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
import { Calendar, Mail, Plug, Radio, Share2, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Badge, useAddonsList, type DataColumn } from '@camstack/ui-library'
import { CAP_PROVIDER_KIND_MAP } from '@camstack/types'
import type { ProviderKind } from '@camstack/types'

import { AdminSectionedPage } from '../../components/AdminSectionedPage'
import { AddonIntegrationBody } from '../../components/integration-hub/AddonIntegrationBody'
import { STATUS_BADGE_CLASS } from '../../components/integration-hub/addon-controls'
import { IntegrationHub } from '../../components/integration-hub/IntegrationHub'
import type { IntegrationGroup } from '../../components/integration-hub/types'
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
import { InstancesTable } from '../../components/instances/InstancesTable'
import type { InstanceRow, PanelRow } from '../../components/instances/instances-model'
import {
  ExportSetupLead,
  exportedDevicesColumn,
} from '../../components/integrations/exported-devices'
import { WasteSettingsSources } from './WasteSettingsSources'
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
  /**
   * A kind whose providers keep `integration-instances` records is one list over this function
   * cap (a row per relay), not a pill per addon.
   */
  readonly instances?: InstancesDescriptor
}

interface InstancesDescriptor {
  readonly functionCap: string
  readonly subtitleKey: string
  readonly subtitleDefault: string
  readonly addLabelKey: string
  readonly addLabelDefault: string
  /** Columns the kind adds to the shared table (after On). */
  readonly extraColumns?: (t: TFunction) => readonly DataColumn<PanelRow>[]
  /** A block at the top of an instance's edit dialog. */
  readonly lead?: (row: InstanceRow) => ReactElement
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
    instances: {
      functionCap: 'device-export',
      subtitleKey: 'system.connectivity.exportersSubtitle',
      subtitleDefault: 'The ecosystems and hubs this hub publishes its devices to.',
      addLabelKey: 'system.connectivity.exportersAdd',
      addLabelDefault: 'Add export',
      extraColumns: (t) => [exportedDevicesColumn(t)],
      lead: (row) => <ExportSetupLead addonId={row.addonId} instanceId={row.id} />,
    },
  },
  {
    sectionId: 'email',
    kind: 'email',
    labelKey: 'system.connectivity.email',
    icon: Mail,
    installLabelKey: 'system.connectivity.emailInstall',
    emptyTitleKey: 'system.connectivity.emailEmptyTitle',
    emptyDescriptionKey: 'system.connectivity.emailEmptyDescription',
    instances: {
      functionCap: 'smtp-provider',
      subtitleKey: 'system.connectivity.emailSubtitle',
      subtitleDefault: 'The SMTP relays that notification targets send mail through.',
      addLabelKey: 'system.connectivity.emailAdd',
      addLabelDefault: 'Add relay',
    },
  },
  {
    sectionId: 'brokers',
    kind: 'broker',
    labelKey: 'system.connectivity.brokers',
    icon: Radio,
    installLabelKey: 'system.connectivity.brokersInstall',
    emptyTitleKey: 'system.connectivity.brokersEmptyTitle',
    emptyDescriptionKey: 'system.connectivity.brokersEmptyDescription',
    instances: {
      functionCap: 'broker',
      subtitleKey: 'system.connectivity.brokersSubtitle',
      subtitleDefault: 'The accounts and connections this hub reaches its devices through.',
      addLabelKey: 'system.connectivity.brokersAdd',
      addLabelDefault: 'Add connection',
    },
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
              </>
            }
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
  const group = useMemo(() => buildGroup(descriptor, rows, t), [descriptor, rows, t])

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
        content:
          descriptor.instances !== undefined ? (
            <InstancesTable
              functionCap={descriptor.instances.functionCap}
              icon={descriptor.icon}
              title={t(descriptor.labelKey)}
              subtitle={t(descriptor.instances.subtitleKey, descriptor.instances.subtitleDefault)}
              emptyTitle={t(descriptor.emptyTitleKey)}
              emptyDescription={t(descriptor.emptyDescriptionKey)}
              addLabel={t(descriptor.instances.addLabelKey, descriptor.instances.addLabelDefault)}
              {...(descriptor.instances.extraColumns !== undefined
                ? { extraColumns: descriptor.instances.extraColumns(t) }
                : {})}
              {...(descriptor.instances.lead !== undefined
                ? { lead: descriptor.instances.lead }
                : {})}
            />
          ) : (
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

function ProcessBadge({ processState }: { readonly processState: string | null }): ReactElement {
  const { state, label } = processPillState(processState)
  const variant = state === 'ok' ? 'success' : state === 'error' ? 'danger' : 'default'
  return (
    <Badge variant={variant} className={`${STATUS_BADGE_CLASS} capitalize`}>
      {label}
    </Badge>
  )
}
