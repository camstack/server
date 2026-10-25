/**
 * "My devices" on My access: the phones the caller keeps signed in with a
 * certificate (`auth.listOwnDeviceCredentials`), each revocable on its own
 * (`auth.revokeOwnDeviceCredential`) — the answer to a lost phone. Only the
 * caller's own devices are ever listed; an admin sees everyone's on Identity →
 * Certificates.
 *
 * Drawn with the SAME `CredentialTable` as Tokens & sessions (owner column
 * hidden, active devices by default, a Revoke button per row). No bulk bar: it
 * is the caller's own short list, and the server has no bulk call for it.
 */
import { trpc, useConfirm } from '@camstack/ui-library'
import { Ban, Smartphone } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { AccessSection, pickNotice } from '../access/AccessSection'
import type { CredentialRowAction } from '../access/credential-columns'
import type { CredentialRow } from '../access/credential-row'
import { CredentialTable } from '../access/CredentialTable'
import { canRevokeDevice } from './certificate-model'
import { ownDeviceCredentialRow } from './device-credential-row'
import { useTranslation } from 'react-i18next'

const OWNER = 'You'

export function MyDevicesSection(): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const query = trpc.auth.listOwnDeviceCredentials.useQuery()
  const [error, setError] = useState<string | null>(null)
  const revoke = trpc.auth.revokeOwnDeviceCredential.useMutation({
    onSuccess: (res) => {
      if (!res.revoked) setError('That device could not be revoked - it may already be gone.')
      void utils.auth.listOwnDeviceCredentials.invalidate()
    },
    onError: (err: { message: string }) => setError(`Revoke failed: ${err.message}`),
  })

  const rows = useMemo(
    () => (query.data ?? []).map((d) => ownDeviceCredentialRow(d, OWNER)),
    [query.data],
  )

  const onRevoke = async (row: CredentialRow): Promise<void> => {
    const ok = await confirm({
      title: t('certificates.myDevicesSection.revoke', 'Revoke "{{name}}"?', { name: row.name }),
      message: t(
        'certificates.myDevicesSection.theDeviceStopsSigningIn',
        'The device stops signing in at once and its open sessions end. To use it again you have to pair it anew. This cannot be undone.',
      ),
      confirmLabel: t('certificates.myDevicesSection.revoke2', 'Revoke'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    revoke.mutate({ id: row.id })
  }

  const action: CredentialRowAction = {
    label: t('certificates.myDevicesSection.revoke2', 'Revoke'),
    icon: Ban,
    isAvailable: canRevokeDevice,
    onRun: (r) => void onRevoke(r),
    busyId: revoke.isPending ? (revoke.variables?.id ?? null) : null,
    disabled: revoke.isPending,
  }

  return (
    <AccessSection
      id="my-devices"
      title={t('certificates.myDevicesSection.myDevices', 'My devices')}
      icon={Smartphone}
      description={t(
        'certificates.myDevicesSection.phonesThatStaySignedIn',
        'Phones that stay signed in to your account with a certificate. If one is lost, revoke it here and it is signed out at once.',
      )}
      notice={pickNotice(error)}
      onDismissNotice={() => setError(null)}
    >
      <CredentialTable
        rows={rows}
        label={t('certificates.devicesCard.label')}
        isLoading={query.isPending}
        loadError={query.error === null ? null : query.error.message || 'Request failed'}
        emptyText="No devices are signed in with a certificate."
        hideOwner
        expiresNone="—"
        action={action}
      />
    </AccessSection>
  )
}
