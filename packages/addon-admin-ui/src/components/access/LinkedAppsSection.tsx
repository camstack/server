/**
 * Linked apps — external integrations (Alexa, …) that completed the OAuth
 * account-link flow and hold refresh / access tokens
 * (`userManagement.listOauthSessions`). Revoking one invalidates that
 * integration's access on its next call. Bulk revoke via
 * `auth.revokeCredentials` (`oauth-session`): active → mark revoked;
 * already-revoked → delete (Remove revoked).
 */
import type { TokenScope } from '@camstack/types'
import {
  useConfirm,
  useUserManagementListOauthSessions,
  useUserManagementRevokeOauthSession,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Link2, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { AccessSection, pickNotice } from './AccessSection'
import { CredentialTable } from './CredentialTable'
import { linkedAppRow, type CredentialRow, type LinkedAppSource } from './credential-row'
import { useBulkRevoke } from './use-bulk-revoke'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const NOUN = { key: 'access.nouns.linkedApp' } as const

interface OauthSessionSummary extends LinkedAppSource {
  readonly scopes: readonly TokenScope[]
}

/** A `TokenScope` in words: "all devices", "device:[1,2]", "addon:alexa". */
export function formatScope(scope: TokenScope): string {
  if (scope.type === 'category') {
    const target = (scope as { target?: string }).target ?? ''
    return target === 'device'
      ? i18n.t('access.linkedAppsSection.allDevices')
      : i18n.t('access.linkedAppsSection.allTarget', { target })
  }
  if (scope.type === 'device') {
    const targets = (scope as { targets?: readonly string[] }).targets ?? []
    return `device:[${targets.join(',')}]`
  }
  const generic = scope as { type: string; target?: string }
  return `${generic.type}:${generic.target ?? ''}`
}

export function LinkedAppsSection(): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const query = useUserManagementListOauthSessions()
  const [error, setError] = useState<string | null>(null)
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: [['userManagement', 'listOauthSessions']] })
  const revoke = useUserManagementRevokeOauthSession({
    onSuccess: refresh,
    onError: (err: { message: string }) => setError(`Revoke failed: ${err.message}`),
  })
  const bulk = useBulkRevoke(NOUN, refresh)

  const rows = useMemo(
    () =>
      ((query.data ?? []) as readonly OauthSessionSummary[]).map((s) =>
        linkedAppRow(s, s.scopes.map(formatScope).join(', ')),
      ),
    [query.data],
  )

  const run = async (row: CredentialRow): Promise<void> => {
    const ok = await confirm({
      title: t('access.linkedAppsSection.revokeTheLink', 'Revoke the "{{name}}" link?', {
        name: row.name,
      }),
      message: t(
        'access.linkedAppsSection.losesAccessForOnIts',
        '{{name}} loses access for {{ownerName}} on its next call. Linking it again needs the account-link flow from the start.',
        { name: row.name, ownerName: row.ownerName },
      ),
      confirmLabel: t('access.linkedAppsSection.revoke', 'Revoke'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    revoke.mutate({ id: row.id })
  }

  const pendingId = revoke.isPending
    ? ((revoke.variables as { id?: string } | undefined)?.id ?? null)
    : null

  return (
    <AccessSection
      notice={pickNotice(error, bulk.outcome)}
      onDismissNotice={() => {
        setError(null)
        bulk.dismiss()
      }}
      id="linked-apps"
      title={t('access.linkedAppsSection.linkedApps', 'Linked apps')}
      icon={Link2}
      description={t(
        'access.linkedAppsSection.externalIntegrationsAlexaLinkedTo',
        'External integrations (Alexa, …) linked to this hub through OAuth. Revoking one stops that integration on its next call. Already-revoked rows can be selected and removed from the list.',
      )}
    >
      <CredentialTable
        rows={rows}
        label={t('access.linkedAppsSection.linkedApps2', 'linked apps')}
        isLoading={query.isLoading}
        loadError={query.isError ? (query.error?.message ?? 'Request failed') : null}
        emptyText="No linked apps — an integration appears here once it completes the account-link flow."
        expiresNone="—"
        action={{
          label: t('access.linkedAppsSection.revoke', 'Revoke'),
          icon: Trash2,
          isAvailable: (r) => r.status === 'active' || r.status === 'revoked',
          onRun: (r) => void run(r),
          busyId: pendingId,
          disabled: revoke.isPending || bulk.busy,
        }}
        bulk={{
          revoke: bulk,
          noun: NOUN,
          isSelectable: (r) => r.status === 'active' || r.status === 'revoked',
          quickSelect: [
            {
              label: t('access.linkedAppsSection.selectRevoked', 'Select revoked'),
              match: (r) => r.status === 'revoked',
            },
          ],
        }}
      />
    </AccessSection>
  )
}
