/**
 * Identity → Certificates → Devices: every phone enrolled with a certificate
 * (`deviceCredentials.listDeviceCredentials`), through the SAME table as
 * Identity → Tokens & sessions (`CredentialTable`, D819): filter chips (active
 * by default), row selection with the bulk bar, a Revoke button per row.
 * Row actions: rename, revoke (a revoked device stops signing in at once),
 * delete (revoked rows only — a clean-up, the audit trail keeps the
 * revocation). Bulk revoke calls the per-device revoke once per selected row.
 * "Pair a device" is the page header's action; this card hosts its dialog.
 *
 * Every state comes from an ANSWERED query (D315): reading, failed (with the
 * reason), and only an answer with no rows says "no devices".
 */
import { trpc, useConfirm, usePrompt, useUserManagementListUsers } from '@camstack/ui-library'
import { Ban, Pencil, Smartphone, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { AccessSection, pickNotice } from '../access/AccessSection'
import type { CredentialRowAction } from '../access/credential-columns'
import type { CredentialRow } from '../access/credential-row'
import { CredentialTable } from '../access/CredentialTable'
import { useEachBulkRevoke } from '../access/use-bulk-revoke'
import { canDeleteDevice, canRevokeDevice } from './certificate-model'
import { deviceCredentialRow } from './device-credential-row'
import { DeviceSettingsRow } from './DeviceSettingsRow'
import { PairDeviceDialog } from './PairDeviceDialog'
import { useTranslation } from 'react-i18next'

const NOUN = { key: 'access.nouns.device' } as const

export interface DevicesCardProps {
  readonly pairOpen: boolean
  readonly onPairClose: () => void
}

export function DevicesCard({ pairOpen, onPairClose }: DevicesCardProps): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const prompt = usePrompt()
  const utils = trpc.useUtils()
  const query = trpc.deviceCredentials.listDeviceCredentials.useQuery({
    includeRevoked: true,
  })
  const users = useUserManagementListUsers()
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const refresh = (): void => void utils.deviceCredentials.listDeviceCredentials.invalidate()
  const failed = (verb: string) => (err: { message: string }) => {
    setBusyId(null)
    setError(`${verb} failed: ${err.message}`)
  }
  const done = (): void => {
    setBusyId(null)
    refresh()
  }

  const revoke = trpc.deviceCredentials.revokeDeviceCredential.useMutation({
    onSuccess: done,
    onError: failed('Revoke'),
  })
  const remove = trpc.deviceCredentials.deleteDeviceCredential.useMutation({
    onSuccess: (res) => {
      if (res.result !== 'deleted') {
        setError(
          res.result === 'live'
            ? 'Only a revoked device can be deleted: revoke it first.'
            : 'That device no longer exists.',
        )
      }
      done()
    },
    onError: failed('Delete'),
  })
  const rename = trpc.deviceCredentials.renameDeviceCredential.useMutation({
    onSuccess: done,
    onError: failed('Rename'),
  })
  const bulk = useEachBulkRevoke(NOUN, (id) => revoke.mutateAsync({ id }), refresh)
  const disabled = bulk.busy || busyId !== null

  const rows = useMemo(() => (query.data ?? []).map(deviceCredentialRow), [query.data])

  const onRevoke = async (row: CredentialRow): Promise<void> => {
    const ok = await confirm({
      title: t('certificates.devicesCard.revoke', 'Revoke "{{name}}"?', { name: row.name }),
      message: t(
        'certificates.devicesCard.sDeviceStopsSigningIn',
        "{{ownerName}}'s device stops signing in at once and its open sessions end. To use it again it has to be paired anew. This cannot be undone.",
        { ownerName: row.ownerName },
      ),
      confirmLabel: t('certificates.devicesCard.revoke2', 'Revoke'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    setBusyId(row.id)
    revoke.mutate({ id: row.id })
  }
  const onDelete = async (row: CredentialRow): Promise<void> => {
    const ok = await confirm({
      title: t('certificates.devicesCard.delete', 'Delete "{{name}}"?', { name: row.name }),
      message: t(
        'certificates.devicesCard.isRemovedFromTheList',
        '{{name}} is removed from the list. The audit trail keeps the revocation.',
        { name: row.name },
      ),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    setBusyId(row.id)
    remove.mutate({ id: row.id })
  }
  const onRename = async (row: CredentialRow): Promise<void> => {
    const next = await prompt({
      title: t('certificates.devicesCard.renameDevice', 'Rename device'),
      label: t('certificates.devicesCard.deviceName', 'Device name'),
      defaultValue: row.name,
      confirmLabel: t('certificates.devicesCard.rename', 'Rename'),
    })
    const name = next?.trim() ?? ''
    if (name === '' || name === row.name) return
    setError(null)
    setBusyId(row.id)
    rename.mutate({ id: row.id, deviceName: name })
  }

  const action: CredentialRowAction = {
    label: t('certificates.devicesCard.revoke2', 'Revoke'),
    icon: Ban,
    isAvailable: canRevokeDevice,
    onRun: (r) => void onRevoke(r),
    busyId: revoke.isPending ? busyId : null,
    disabled,
  }
  const extraActions: readonly CredentialRowAction[] = [
    {
      label: t('certificates.devicesCard.rename', 'Rename'),
      icon: Pencil,
      tone: 'neutral',
      isAvailable: () => true,
      onRun: (r) => void onRename(r),
      busyId: rename.isPending ? busyId : null,
      disabled,
    },
    {
      label: t('common.delete', 'Delete'),
      icon: Trash2,
      isAvailable: canDeleteDevice,
      onRun: (r) => void onDelete(r),
      busyId: remove.isPending ? busyId : null,
      disabled,
    },
  ]

  return (
    <AccessSection
      id="devices"
      title={t('certificates.devicesCard.devices', 'Devices')}
      icon={Smartphone}
      description={t(
        'certificates.devicesCard.phonesThatStaySignedIn',
        'Phones that stay signed in with a certificate instead of a login. Revoking one signs it out at once; it has to be paired again.',
      )}
      notice={pickNotice(error, bulk.outcome)}
      onDismissNotice={() => {
        setError(null)
        bulk.dismiss()
      }}
    >
      <DeviceSettingsRow />
      <CredentialTable
        rows={rows}
        label={t('certificates.devicesCard.label')}
        isLoading={query.isPending}
        loadError={query.error === null ? null : query.error.message || 'Request failed'}
        emptyText="No devices paired yet."
        expiresNone="—"
        action={action}
        extraActions={extraActions}
        bulk={{ revoke: bulk, noun: NOUN, isSelectable: canRevokeDevice }}
      />
      <PairDeviceDialog
        open={pairOpen}
        users={users.data ?? []}
        onClose={onPairClose}
        onPaired={refresh}
      />
    </AccessSection>
  )
}
