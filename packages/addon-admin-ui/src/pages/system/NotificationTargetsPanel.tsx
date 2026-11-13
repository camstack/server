/**
 * Notification targets (Notifications → Targets): one `<InstancesTable>` over the function cap
 * `notification-output`. A target is an instance of a kind (ntfy, Telegram, webhook, ...), so the
 * list, the add / edit form, the on-switch, the connection test and the delete are the ones every
 * instance list shares. This page adds only what is specific to a target: who owns it, and the
 * test panel that sends a sample the kind can honour.
 */
import { notificationTargetKindOf, type Target } from '@camstack/types'
import { IconButton, Badge, Skeleton, useInstancesOfCap, useSystem } from '@camstack/ui-library'
import type { DataColumn, LinkableInstance } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { Bell, Send } from 'lucide-react'
import { useCallback, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { InstancesTable } from '../../components/instances/InstancesTable'
import type { InstanceRow, PanelRow } from '../../components/instances/instances-model'
import { NotificationTestPanel } from './NotificationTestPanel'

/** The key a target's owner is stored under, in its form values (the scoped integration-instances write stamps it). */
const TARGET_OWNER_KEY = 'ownerUserId'

const NOTIFICATION_OUTPUT_CAP = 'notification-output'

/** The owner userId a target carries, or null for a system/global target. */
export function targetOwnerUserId(instance: Pick<LinkableInstance, 'formValues'>): string | null {
  const raw = instance.formValues[TARGET_OWNER_KEY]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function OwnerCell({ row }: { readonly row: PanelRow }): ReactElement | null {
  const { t } = useTranslation()
  const system = useSystem()
  const targets = useInstancesOfCap({ functionCap: NOTIFICATION_OUTPUT_CAP })
  const users = useQuery({
    queryKey: ['userManagement', 'listUsers'],
    queryFn: () => system.trpcClient.userManagement.listUsers.query(),
  })
  if (row.kind !== 'instance') return null
  const instance = (targets.data ?? []).find((i) => i.id === row.id)
  const owner = instance === undefined ? null : targetOwnerUserId(instance)
  if (owner === null) return <Badge variant="default">{t('common.systemWord', 'system')}</Badge>
  // The id is never shown: unanswered is a skeleton, an owner the list does not know is named so.
  if (users.data === undefined && !users.isError) return <Skeleton className="h-3 w-16" />
  const name = (users.data ?? []).find((u) => u.id === owner)?.username
  return (
    <span className="text-xs text-foreground">
      {name ?? t('system.notificationTargets.unknownUser', 'unknown user')}
    </span>
  )
}

function ownerColumn(label: string): DataColumn<PanelRow> {
  return {
    key: 'owner',
    header: label,
    nowrap: true,
    notSortableReason: label,
    render: (row) => <OwnerCell row={row} />,
  }
}

export function NotificationTargetsPanel(): ReactElement {
  const { t } = useTranslation()
  const system = useSystem()
  const kinds = useQuery({
    queryKey: ['notificationOutput', 'listTargetKinds'],
    queryFn: () => system.trpcClient.notificationOutput.listTargetKinds.query({}),
  })
  const [testing, setTesting] = useState<InstanceRow | null>(null)

  const testKind =
    testing === null || testing.kindId === undefined
      ? undefined
      : (kinds.data ?? []).find(
          (k) =>
            k.kind === notificationTargetKindOf(testing.kindId ?? '') &&
            k.addonId === testing.addonId,
        )

  const rowActions = useCallback(
    (row: InstanceRow): ReactElement => (
      <IconButton
        icon={Send}
        variant="ghost"
        size="sm"
        aria-label={t('system.notificationTargets.testTarget', 'Send a test to {{name}}', {
          name: row.name,
        })}
        onClick={() => setTesting(row)}
      />
    ),
    [t],
  )

  const testTarget: Target | null =
    testing === null || testKind === undefined
      ? null
      : {
          id: testing.id,
          name: testing.name,
          kind: testKind.kind,
          addonId: testing.addonId,
          enabled: testing.enabled,
          config: {},
        }

  return (
    <>
      <InstancesTable
        functionCap={NOTIFICATION_OUTPUT_CAP}
        icon={Bell}
        title={t('system.notificationTargets.notificationTargets', 'Notification Targets')}
        subtitle={t(
          'system.notificationTargets.deliverNotificationsToNtfyPushover',
          "Deliver notifications to ntfy, Pushover, Telegram, Home Assistant and more. Each target's kind declares its capabilities; the test panel shows exactly what a message degrades to.",
        )}
        emptyTitle={t('system.notificationTargets.emptyTitle', 'No notification targets yet')}
        emptyDescription={t(
          'system.notificationTargets.emptyDescription',
          'Add a target to deliver notifications to ntfy, Pushover, Telegram, Home Assistant and more.',
        )}
        addLabel={t('system.notificationTargets.addTarget', 'Add target')}
        testLabel={t('system.notificationTargets.sendTest', 'Send test message')}
        testHint={t(
          'system.notificationTargets.sendTestHint',
          'Send test message delivers a real notification to the destination typed above, before you save.',
        )}
        extraColumns={[ownerColumn(t('system.notificationTargets.owner', 'Owner'))]}
        rowActions={rowActions}
      />
      {testTarget !== null && testKind !== undefined && (
        <NotificationTestPanel
          target={testTarget}
          kind={testKind}
          open
          onClose={() => setTesting(null)}
        />
      )}
    </>
  )
}

export default NotificationTargetsPanel
