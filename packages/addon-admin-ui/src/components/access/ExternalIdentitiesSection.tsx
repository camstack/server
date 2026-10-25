/**
 * Sign-in links (D782) — the external identities (OIDC, …) each user linked
 * to their account, every user's in one table. The hub lists them per user
 * (`userManagement.listExternalIdentities({ userId })`), so this fans out one
 * query per user.
 *
 * Admins can see and remove a link, never create one: a link is made only by
 * its owner, from their profile, inside their own session. A link whose
 * provider is no longer offered keeps its raw provider id as its Kind.
 */
import {
  trpc,
  useConfirm,
  useUserManagementListUsers,
  useUserManagementUnlinkExternalIdentity,
} from '@camstack/ui-library'
import { Fingerprint, Unlink } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { AccessSection, useUserNames, pickNotice } from './AccessSection'
import { CredentialTable } from './CredentialTable'
import {
  externalIdentityKey,
  externalIdentityRow,
  type CredentialRow,
  type ExternalIdentitySource,
} from './credential-row'
import { useTranslation } from 'react-i18next'

export function ExternalIdentitiesSection(): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const names = useUserNames()
  const { data: users, isLoading: usersLoading } = useUserManagementListUsers()
  const userList = useMemo(() => users ?? [], [users])
  const perUser = trpc.useQueries((t) =>
    userList.map((u) => t.userManagement.listExternalIdentities({ userId: u.id })),
  )
  const methods = trpc.auth.listLoginMethods.useQuery()
  const [error, setError] = useState<string | null>(null)
  const unlink = useUserManagementUnlinkExternalIdentity({
    onSuccess: () => void utils.userManagement.listExternalIdentities.invalidate(),
    onError: (err: { message: string }) => setError(`Remove failed: ${err.message}`),
  })

  const providerLabel = useMemo(
    () =>
      new Map(
        (methods.data ?? []).flatMap((m) =>
          m.kind === 'redirect' ? [[m.id, m.label] as const] : [],
        ),
      ),
    [methods.data],
  )
  const sources = userList.flatMap(
    (_, i) => (perUser[i]?.data ?? []) as readonly ExternalIdentitySource[],
  )
  const rows = sources.map((src) => {
    const row = externalIdentityRow(src, names)
    return { ...row, kind: providerLabel.get(src.provider) ?? src.provider }
  })

  const remove = async (row: CredentialRow): Promise<void> => {
    const source = sources.find((s) => externalIdentityKey(s) === row.id)
    if (source === undefined) return
    const ok = await confirm({
      title: t('access.externalIdentitiesSection.removeSignInLink', 'Remove sign-in link'),
      message: t(
        'access.externalIdentitiesSection.willNoLongerBeAble',
        '"{{ownerName}}" will no longer be able to sign in with this {{kind}} account.',
        { ownerName: row.ownerName, kind: row.kind },
      ),
      confirmLabel: t('common.remove', 'Remove'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    unlink.mutate({ userId: source.userId, provider: source.provider, subject: source.subject })
  }

  return (
    <AccessSection
      notice={pickNotice(error)}
      onDismissNotice={() => {
        setError(null)
      }}
      id="external-identities"
      title={t('access.externalIdentitiesSection.signInLinks', 'Sign-in links')}
      icon={Fingerprint}
      description={t(
        'access.externalIdentitiesSection.externalAccountsSingleSignOn',
        'External accounts (single sign-on) each user linked to their CamStack account. Only the owner can link one, from their profile; an admin can remove it.',
      )}
    >
      <CredentialTable
        rows={rows}
        label="sign-in links"
        isLoading={usersLoading || perUser.some((q) => q.isLoading)}
        loadError={perUser.find((q) => q.isError)?.error?.message ?? null}
        emptyText="No user has linked a sign-in account."
        expiresNone="—"
        action={{
          label: t('common.remove', 'Remove'),
          icon: Unlink,
          isAvailable: () => true,
          onRun: (r) => void remove(r),
          busyId: null,
          disabled: unlink.isPending,
        }}
      />
    </AccessSection>
  )
}
