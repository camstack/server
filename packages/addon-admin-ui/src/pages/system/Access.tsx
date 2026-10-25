/**
 * Identity → Tokens & sessions — every credential the hub honours, one kind at
 * a time (D819).
 *
 * Kind picker is the same pills strip as Notification Center → Rules
 * (`Tabs appearance="pills"` + `?integration=<kind>`), not the IntegrationHub
 * group rows (Sessions / Tokens / Identity). The old `?tab=api-keys` and
 * `?tab=linked-sessions` links still land here (see `Identity.tsx`).
 *
 * Every body is the same `CredentialTable`. Bulk revoke exists only where the
 * hub has an audited bulk call and only as selection → typed count → exact ids.
 *
 * Credential create dialogs use `useItemFormUrl` with kind-specific keys
 * (`ACCESS_CREATE_URL_KEYS`) so they never collide with Users' `?new=1`.
 */
import { Button, Tabs, TabsList, TabsTrigger } from '@camstack/ui-library'
import {
  Fingerprint,
  KeyRound,
  Link2,
  MonitorSmartphone,
  ScrollText,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'

import { ExternalIdentitiesSection } from '../../components/access/ExternalIdentitiesSection'
import { LinkedAppsSection } from '../../components/access/LinkedAppsSection'
import { LoginSessionsSection } from '../../components/access/LoginSessionsSection'
import { TokensSection } from '../../components/access/TokensSection'
import { AuthAuditSection } from '../../components/auth/AuthAuditSection'
import { useIntegrationSelection } from '../../hooks/useIntegrationSelection'
import { selectIntegrationParams } from '../../lib/integration-hub-url'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

/** Re-export for Identity tab `ownedParams` (clear create keys on leave). */
export { ACCESS_CREATE_URL_KEYS } from '../../components/access/access-create-url'

/** The `?integration=` value of each kind — also what old links redirect to. */
export const ACCESS_KINDS = {
  loginSessions: 'login-sessions',
  linkedApps: 'linked-apps',
  tokens: 'tokens',
  /** Retired — redirect to `tokens`. */
  scopedTokens: 'scoped-tokens',
  /** Retired — redirect to `tokens`. */
  adminTokens: 'admin-tokens',
  /** Retired — a share link is a token (a view of a few cameras): redirect to `tokens`. */
  shareLinks: 'share-links',
  externalIdentities: 'external-identities',
  audit: 'auth-audit',
} as const

/** Old pill ids that now open the merged Tokens kind. */
export const RETIRED_ACCESS_INTEGRATIONS: Readonly<Record<string, string>> = {
  [ACCESS_KINDS.scopedTokens]: ACCESS_KINDS.tokens,
  [ACCESS_KINDS.adminTokens]: ACCESS_KINDS.tokens,
  [ACCESS_KINDS.shareLinks]: ACCESS_KINDS.tokens,
}

interface AccessKind {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  readonly render: (opts: {
    readonly createRequested: boolean
    readonly onCreateConsumed: () => void
  }) => ReactElement
}

function buildKinds(): readonly AccessKind[] {
  return [
    {
      id: ACCESS_KINDS.loginSessions,
      label: i18n.t('system.access.loginSessions', 'Login sessions'),
      icon: MonitorSmartphone,
      render: () => <LoginSessionsSection />,
    },
    {
      id: ACCESS_KINDS.linkedApps,
      label: i18n.t('system.access.linkedApps', 'Linked apps'),
      icon: Link2,
      render: () => <LinkedAppsSection />,
    },
    {
      id: ACCESS_KINDS.tokens,
      label: i18n.t('system.access.tokens', 'Tokens'),
      icon: KeyRound,
      render: ({ createRequested, onCreateConsumed }) => (
        <TokensSection
          headerOwnsCreate
          createRequested={createRequested}
          onCreateConsumed={onCreateConsumed}
        />
      ),
    },
    {
      id: ACCESS_KINDS.externalIdentities,
      label: i18n.t('system.access.signInLinks', 'Sign-in links'),
      icon: Fingerprint,
      render: () => <ExternalIdentitiesSection />,
    },
    {
      id: ACCESS_KINDS.audit,
      label: i18n.t('system.access.audit', 'Audit'),
      icon: ScrollText,
      render: () => <AuthAuditSection />,
    },
  ]
}

export interface AccessPageProps {
  /** Identity header: New token pulse while Tokens is selected. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

export function AccessPage({
  createRequested = false,
  onCreateConsumed,
}: AccessPageProps): ReactElement {
  const { t } = useTranslation()
  const kinds = useMemo(() => buildKinds(), [])
  const ids = useMemo(() => kinds.map((k) => k.id), [kinds])

  const selection = useIntegrationSelection({
    ids,
    answered: true,
  })
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const integration = searchParams.get('integration')
  const retiredTarget = integration !== null ? RETIRED_ACCESS_INTEGRATIONS[integration] : undefined
  if (retiredTarget !== undefined) {
    const next = new URLSearchParams(searchParams)
    next.set('integration', retiredTarget)
    return <Navigate to={`?${next.toString()}`} replace />
  }

  const selected = kinds.find((k) => k.id === selection.selectedId) ?? kinds[0]
  const activeId = selected?.id ?? ACCESS_KINDS.loginSessions

  const setKind = (next: string): void => {
    navigate(`?${selectIntegrationParams(searchParams, next, null, null).toString()}`)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="access-page">
      <Tabs appearance="pills" value={activeId} onValueChange={setKind}>
        <TabsList aria-label={t('system.access.credentialKinds', 'Credential kinds')}>
          {kinds.map((kind) => (
            <TabsTrigger key={kind.id} value={kind.id} data-testid={`access-kind-${kind.id}`}>
              <kind.icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {kind.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {selected !== undefined ? (
        <div
          key={selected.id}
          role="region"
          aria-label={selected.label}
          data-testid="access-kind-body"
        >
          {selected.render({
            createRequested: createRequested && selected.id === ACCESS_KINDS.tokens,
            onCreateConsumed: onCreateConsumed ?? (() => undefined),
          })}
        </div>
      ) : null}
    </div>
  )
}

/** Header actions for Identity when Tokens & sessions is the active tab. */
export function accessHeaderActions(integration: string | null, onNewToken: () => void): ReactNode {
  if (integration === ACCESS_KINDS.tokens) {
    return (
      <Button size="sm" type="button" data-testid="access-new-token" onClick={onNewToken}>
        <KeyRound className="h-3.5 w-3.5" aria-hidden />
        {i18n.t('system.access.newToken', 'New token')}
      </Button>
    )
  }
  return undefined
}

/** Hook-friendly wrapper used by Identity.tsx. */
export function useAccessHeaderCreate(): {
  readonly createRequested: boolean
  readonly requestCreate: () => void
  readonly clearCreate: () => void
} {
  const [createRequested, setCreateRequested] = useState(false)
  return {
    createRequested,
    requestCreate: () => setCreateRequested(true),
    clearCreate: () => setCreateRequested(false),
  }
}
