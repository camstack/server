/**
 * B2: when an addon declares a `brokers` entry kind, list/edit via record-entries.
 *
 * The generic entries table only edits and deletes rows. A broker row also has a
 * live status and, for a provider that advertises one, an interactive sign-in
 * (`broker.listProviders` → `interactiveConnectPath` / `interactiveDisconnectPath`),
 * so those come from the broker cap and are added to the panel as a status column
 * and per-row actions — the same data and wording `BrokerManager` uses, and never
 * a branch on an addon id or a kind.
 */
import { useMemo, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, LogIn, LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { EntryView, UnifiedBrokerInfo } from '@camstack/types'
import {
  Button,
  ErrorBox,
  RecordEntriesPanel,
  useBrokerList,
  useBrokerListProviders,
  useRecordEntriesListEntryKinds,
  type DataColumn,
} from '@camstack/ui-library'
import { startBrokerInteractiveConnect } from '../../lib/broker-oauth-popup'
import { BrokerStatusPill } from './BrokerManager'
import { asBrokerList, asProviderList } from './broker-kinds'

export interface BrokerRecordEntriesPanelProps {
  readonly addonId: string
  readonly fallback: JSX.Element
}

interface ConnectPaths {
  readonly connect?: string
  readonly disconnect?: string
}

export function BrokerRecordEntriesPanel({
  addonId,
  fallback,
}: BrokerRecordEntriesPanelProps): JSX.Element {
  const { t } = useTranslation()
  const kindsQuery = useRecordEntriesListEntryKinds({})
  if (kindsQuery.isPending) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (kindsQuery.isError) {
    return (
      <ErrorBox
        message={t(
          'brokers.brokerRecordEntriesPanel.loadKindsFailed',
          'Could not load entry kinds',
        )}
      />
    )
  }
  const kind = kindsQuery.data.kinds.find((k) => k.owner === addonId && k.kind === 'brokers')
  if (kind === undefined) return fallback
  return <BrokerEntriesWithActions addonId={addonId} kind={kind} />
}

function BrokerEntriesWithActions({
  addonId,
  kind,
}: {
  readonly addonId: string
  readonly kind: React.ComponentProps<typeof RecordEntriesPanel>['kind']
}): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const listQuery = useBrokerList({})
  const providersQuery = useBrokerListProviders()

  const brokerById = useMemo(() => {
    const byId = new Map<string, UnifiedBrokerInfo>()
    for (const b of asBrokerList(listQuery.data)) {
      if (b.addonId === addonId) byId.set(b.id, b)
    }
    return byId
  }, [listQuery.data, addonId])

  // `addonId::kind` → the paths that provider advertises for that kind.
  const pathsByKind = useMemo(() => {
    const out = new Map<string, ConnectPaths>()
    for (const provider of asProviderList(providersQuery.data)) {
      for (const k of provider.kinds) {
        const connect = k.interactiveConnectPath
        const disconnect = k.interactiveDisconnectPath
        out.set(`${provider.addonId}::${k.kind}`, {
          ...(typeof connect === 'string' && connect.length > 0 ? { connect } : {}),
          ...(typeof disconnect === 'string' && disconnect.length > 0 ? { disconnect } : {}),
        })
      }
    }
    return out
  }, [providersQuery.data])

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: [['broker']] })
    void queryClient.invalidateQueries({ queryKey: [['recordEntries']] })
  }

  const extraColumns = useMemo(
    (): readonly DataColumn<EntryView>[] => [
      {
        key: 'status',
        header: t('brokers.brokerManager.status', 'Status'),
        nowrap: true,
        width: 'w-px',
        render: (row) => {
          const broker = brokerById.get(row.id)
          return broker === undefined ? null : <BrokerStatusPill status={broker.status} />
        },
      },
    ],
    [brokerById, t],
  )

  const rowActions = (row: EntryView): JSX.Element | null => {
    // Unknown is not absent: a row the broker list has not answered for shows nothing.
    const broker = brokerById.get(row.id)
    if (broker === undefined) return null
    const paths = pathsByKind.get(`${broker.addonId}::${broker.kind}`)
    if (paths === undefined) return null
    const connected = broker.status === 'connected'
    return (
      <>
        {paths.connect !== undefined && !connected && (
          <Button
            variant="primary"
            size="sm"
            aria-label={t('brokers.brokerManager.signIn')}
            onClick={() => startBrokerInteractiveConnect(paths.connect ?? '', broker.id, refresh)}
            title={t(
              'brokers.brokerManager.signInOpensAPopup',
              'Sign in — opens a popup that closes when done',
            )}
          >
            <LogIn className="h-3 w-3" />
            <span className="hidden sm:inline">{t('brokers.brokerManager.signIn')}</span>
          </Button>
        )}
        {paths.disconnect !== undefined && connected && (
          <Button
            variant="outline"
            size="sm"
            aria-label={t('brokers.brokerManager.signOut')}
            onClick={() =>
              startBrokerInteractiveConnect(paths.disconnect ?? '', broker.id, refresh)
            }
            title={t(
              'brokers.brokerManager.signOutClearsTheLinked',
              'Sign out — clears the linked Google account on this broker',
            )}
          >
            <LogOut className="h-3 w-3" />
            <span className="hidden sm:inline">{t('brokers.brokerManager.signOut')}</span>
          </Button>
        )}
      </>
    )
  }

  return (
    <RecordEntriesPanel
      kind={kind}
      extraColumns={extraColumns}
      rowActions={rowActions}
      showUpdated={false}
      minWidthPx={340}
    />
  )
}
