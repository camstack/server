/**
 * Tokens — every token the hub honours, in one table (D892/D895): there is one
 * format and what a token may do is its scopes. A script's admin token is a
 * token holding all permissions; a share link is a token whose only scope is a
 * view of a few cameras. Listed by `auth.listTokens`, created by
 * `auth.mintToken`, revoked by `auth.revokeToken` (one) or
 * `auth.revokeCredentials` (a typed-count selection). Create is owned by the
 * Identity page header (`headerOwnsCreate`).
 */
import type { UiTextFn } from '@camstack/ui-library'
import {
  Button,
  describeDeviceSelector,
  trpc,
  useConfirm,
  useDeviceManagerListAll,
  useItemFormUrl,
  useUserManagementListUsers,
  useUiText,
} from '@camstack/ui-library'
import type { DeviceSelector } from '@camstack/types'
import { KeyRound, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { useAuth } from '../../contexts/auth-context'
import { useReauthPrompt } from '../auth/ReauthDialog'
import { RevealTokenModal } from '../auth/TokenModals'
import { ACCESS_CREATE_URL_KEYS } from './access-create-url'
import { AccessSection, pickNotice, useUserNames } from './AccessSection'
import { CreateTokenModal, type CreateTokenInput } from './CreateTokenModal'
import { CredentialTable } from './CredentialTable'
import {
  describeTokenScope,
  tokenRow,
  TOKEN_REACH_ALL,
  type CredentialRow,
  type GrantScopeSource,
  type TokenSource,
} from './credential-row'
import { useBulkRevoke } from './use-bulk-revoke'
import { useTranslation } from 'react-i18next'

const NOUN = { key: 'access.nouns.token' } as const

function isDeviceSelector(value: unknown): value is DeviceSelector {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/** A capability / addon / category / device grant, in words. */
function describeGrant(scope: GrantScopeSource, uiText: UiTextFn): string {
  const access = scope.access !== undefined ? ` [${scope.access.join(', ')}]` : ''
  if (scope.type === 'device') {
    const devices = isDeviceSelector(scope.selector)
      ? describeDeviceSelector(scope.selector, uiText)
      : '?'
    return `device:[${devices}]${access}`
  }
  if (scope.type === 'addon-routes') {
    return `${uiText('access.tokensSection.everyAddonRoutes', "every addon's routes")}${access}`
  }
  return `${scope.type}:${scope.target ?? ''}${access}`
}

export interface TokensSectionProps {
  /** When true, New token lives on the Identity header — no actions here. */
  readonly headerOwnsCreate?: boolean
  /** Pulse from the header: open the create dialog once. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
  /** Only the caller's own tokens (My access). */
  readonly ownOnly?: boolean
}

export function TokensSection({
  headerOwnsCreate = false,
  createRequested = false,
  onCreateConsumed,
  ownOnly = false,
}: TokensSectionProps): ReactNode {
  const { t } = useTranslation()
  const uiText = useUiText()
  const { user } = useAuth()
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const names = useUserNames()
  const { data: users } = useUserManagementListUsers()
  const userList = useMemo(() => users ?? [], [users])
  const { data: devices } = useDeviceManagerListAll({})
  const cameras = useMemo(() => {
    const byId = new Map<number, string>()
    for (const d of devices ?? []) byId.set(d.id, d.name)
    return byId
  }, [devices])
  const tokens = trpc.auth.listTokens.useQuery(undefined)
  const { requestProof, dialog } = useReauthPrompt('Creating a token with all permissions')

  const {
    state: formUrl,
    openNew,
    close: closeForm,
  } = useItemFormUrl({
    newKey: ACCESS_CREATE_URL_KEYS.token,
  })

  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [awaitingProof, setAwaitingProof] = useState(false)
  const [revealed, setRevealed] = useState<{ token: string; label: string } | null>(null)
  const [singleBusyId, setSingleBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!createRequested) return
    openNew()
    onCreateConsumed?.()
  }, [createRequested, openNew, onCreateConsumed])

  const invalidate = () => {
    void utils.auth.listTokens.invalidate()
    void utils.auth.listAuthAudit.invalidate()
  }

  const mint = trpc.auth.mintToken.useMutation({
    onSuccess: ({ token, record }: { token: string; record: { label: string } }) => {
      invalidate()
      closeForm()
      setFormError(null)
      setAwaitingProof(false)
      setRevealed({ token, label: record.label })
    },
    onError: (err: { message: string }) => {
      setFormError(`Create failed: ${err.message}`)
      setAwaitingProof(false)
    },
  })
  const revoke = trpc.auth.revokeToken.useMutation({
    onSuccess: () => {
      setSingleBusyId(null)
      invalidate()
    },
    onError: (err: { message: string }) => {
      setSingleBusyId(null)
      setError(`Revoke failed: ${err.message}`)
    },
  })
  const bulk = useBulkRevoke(NOUN, invalidate)

  const now = Date.now()
  const listed = (tokens.data ?? []) as readonly TokenSource[]
  const rows = listed
    .filter((tok) => !ownOnly || tok.subjectId === user?.id)
    .map((tok) =>
      tokenRow(
        tok,
        names,
        // All permissions is the whole story; anything else is listed scope by scope.
        tok.scopes.includes('*')
          ? null
          : tok.scopes
              .map((scope) => describeTokenScope(scope, cameras, (g) => describeGrant(g, uiText)))
              .join(', '),
        now,
      ),
    )

  const runOne = async (row: CredentialRow): Promise<void> => {
    const ok = await confirm({
      title: t('access.tokensSection.revoke', 'Revoke "{{name}}"?', { name: row.name }),
      message:
        row.kind === TOKEN_REACH_ALL
          ? t(
              'access.tokensSection.everyScriptUsingItLoses',
              'Every script using it loses access immediately. This cannot be undone.',
            )
          : t(
              'access.tokensSection.stopsWorking',
              'Whoever holds it loses access immediately. This cannot be undone.',
            ),
      confirmLabel: t('access.tokensSection.revoke2', 'Revoke'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    setSingleBusyId(row.id)
    revoke.mutate({ id: row.id })
  }

  const submit = (input: CreateTokenInput): void => {
    void (async () => {
      setError(null)
      setFormError(null)
      let reauthToken: string | undefined
      if (input.scopes.includes('*')) {
        setAwaitingProof(true)
        const proof = await requestProof()
        setAwaitingProof(false)
        if (proof === null) return
        reauthToken = proof
      }
      mint.mutate({
        scopes: [...input.scopes],
        expiresIn: input.expiresIn,
        label: input.label,
        ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
        ...(reauthToken !== undefined ? { reauthToken } : {}),
      })
    })()
  }

  return (
    <div data-testid="tokens">
      {dialog}
      <AccessSection
        notice={pickNotice(error, bulk.outcome)}
        onDismissNotice={() => {
          setError(null)
          bulk.dismiss()
        }}
        id={ownOnly ? 'my-tokens' : 'tokens'}
        title={
          ownOnly
            ? t('access.tokensSection.myTokens', 'My tokens')
            : t('access.tokensSection.tokens', 'Tokens')
        }
        icon={KeyRound}
        actions={
          headerOwnsCreate ? undefined : (
            <Button size="sm" type="button" data-testid="tokens-new" onClick={openNew}>
              <KeyRound className="h-3.5 w-3.5" aria-hidden />
              {t('system.access.newToken', 'New token')}
            </Button>
          )
        }
        description={t(
          'access.tokensSection.oneFormat',
          'Every token is its scopes: a few permissions for a script, all permissions for an admin script, or a view of some cameras for a share link. Revoking one stops it on its next use.',
        )}
      >
        <CredentialTable
          rows={rows}
          label={t('common.tokensLabel')}
          isLoading={tokens.isLoading}
          loadError={tokens.isError ? (tokens.error?.message ?? 'Request failed') : null}
          emptyText={t('access.tokensSection.noTokens', 'No tokens.')}
          action={{
            label: t('access.tokensSection.revoke2', 'Revoke'),
            icon: Trash2,
            isAvailable: (r) => r.status === 'active',
            onRun: (r) => void runOne(r),
            busyId: singleBusyId,
            disabled: bulk.busy || singleBusyId !== null,
          }}
          /* The bulk revoke is an admin's (`auth.revokeCredentials`). */
          {...(user?.isAdmin === true
            ? {
                bulk: {
                  revoke: bulk,
                  noun: NOUN,
                  isSelectable: (r: CredentialRow) => r.status === 'active',
                },
              }
            : {})}
        />
      </AccessSection>

      <CreateTokenModal
        open={formUrl.mode === 'new'}
        users={userList.map((u) => ({ id: u.id, username: u.username }))}
        onClose={() => {
          closeForm()
          setFormError(null)
          setAwaitingProof(false)
        }}
        submitting={mint.isPending}
        formError={formError}
        awaitingProof={awaitingProof}
        onSubmit={submit}
      />

      {revealed && (
        <RevealTokenModal
          token={revealed.token}
          label={revealed.label}
          onClose={() => setRevealed(null)}
        />
      )}
    </div>
  )
}
