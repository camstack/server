/**
 * "My access" — the signed-in user's self-service page, one section at a time
 * (`AdminSectionedPage`, the active section in `?tab=`):
 *
 *   - Profile             — who you are, the admin notice, your granted scopes
 *   - Sign-in & security  — password, two-factor, passkeys, linked sign-in accounts
 *   - Sessions & devices  — your login sessions, phones kept signed in, connect a phone
 *   - Tokens              — your own tokens and share links
 *   - Preferences         — how readings are shown to you (units)
 *
 * A linked-account popup returns here with `?linked=` / `?linkError=` and no
 * tab; that return opens Sign-in & security, where the outcome is shown.
 */
import type { ReactElement } from 'react'
import { Eye, Info, LogOut, Pencil, ShieldCheck, Trash2 } from 'lucide-react'
import { Navigate, useSearchParams } from 'react-router-dom'
import type { TokenScope } from '@camstack/types'
import { Button, describeDeviceSelector, useUiText } from '@camstack/ui-library'
import { Trans, useTranslation } from 'react-i18next'

import { useAuth, type AuthUser } from '../../contexts/auth-context'
import { AdminPage } from '../../components/AdminPage'
import { AdminSectionedPage } from '../../components/AdminSectionedPage'
import { ConnectPhoneCard } from '../../components/users/ConnectPhoneCard'
import { LinkedSignInsSection } from '../../components/users/LinkedSignInsSection'
import {
  ChangePasswordSection,
  PasskeySection,
  TotpSection,
} from '../../components/users/OwnSignInSections'
import { UnitsSection } from '../../components/users/UnitsSection'
import { TokensSection } from '../../components/access/TokensSection'
import { MySessionsSection } from '../../components/auth/MySessionsSection'
import { MyDevicesSection } from '../../components/certificates/MyDevicesSection'

/** The `?tab=` value of each My access section — also what links point at. */
export const MY_ACCESS_SECTIONS = {
  profile: 'profile',
  signIn: 'sign-in',
  sessions: 'sessions',
  tokens: 'tokens',
  preferences: 'preferences',
} as const

/** The params a linked-account popup returns with (read by `LinkedSignInsSection`). */
const LINK_OUTCOME_PARAMS = ['linked', 'linkError'] as const

const ACCESS_META: Record<'view' | 'create' | 'delete', { icon: typeof Eye; cls: string }> = {
  view: { icon: Eye, cls: 'bg-foreground-subtle/15 text-foreground-subtle' },
  create: { icon: Pencil, cls: 'bg-primary/15 text-primary' },
  delete: { icon: Trash2, cls: 'bg-danger/15 text-danger' },
}

export function MyAccessPage(): ReactElement {
  const { t } = useTranslation()
  const { user, logout } = useAuth()
  const [searchParams] = useSearchParams()
  const title = t('system.myAccess', 'My access')

  if (!user) {
    return (
      <AdminPage icon={ShieldCheck} title={title}>
        <div className="text-xs text-foreground-subtle">
          {t('systemPage.myAccess.notSignedIn', 'Not signed in.')}
        </div>
      </AdminPage>
    )
  }

  const returnsFromLink = LINK_OUTCOME_PARAMS.some((p) => searchParams.has(p))
  if (returnsFromLink && !searchParams.has('tab')) {
    const next = new URLSearchParams(searchParams)
    next.set('tab', MY_ACCESS_SECTIONS.signIn)
    return <Navigate to={`?${next.toString()}`} replace />
  }

  return (
    <AdminSectionedPage
      icon={ShieldCheck}
      title={title}
      subtitle={t(
        'systemPage.myAccess.subtitle',
        'Your account, how you sign in, where you are signed in, and your tokens.',
      )}
      sectionsLabel={t('systemPage.myAccess.sectionsLabel', 'My access sections')}
      defaultSection={MY_ACCESS_SECTIONS.profile}
      actions={
        <Button variant="outline" onClick={logout}>
          <LogOut className="h-3 w-3" />
          {t('systemPage.myAccess.signOut', 'Sign out')}
        </Button>
      }
      sections={[
        {
          id: MY_ACCESS_SECTIONS.profile,
          label: t('systemPage.myAccess.sections.profile', 'Profile'),
          content: <ProfileSection user={user} />,
        },
        {
          id: MY_ACCESS_SECTIONS.signIn,
          label: t('systemPage.myAccess.sections.signIn', 'Sign-in & security'),
          content: (
            <div className="space-y-4">
              <ChangePasswordSection />
              <TotpSection username={user.username} />
              <PasskeySection />
              <LinkedSignInsSection />
            </div>
          ),
        },
        {
          id: MY_ACCESS_SECTIONS.sessions,
          label: t('systemPage.myAccess.sections.sessions', 'Sessions & devices'),
          content: (
            <div className="space-y-4">
              <MySessionsSection />
              <MyDevicesSection />
              <ConnectPhoneCard />
            </div>
          ),
        },
        {
          id: MY_ACCESS_SECTIONS.tokens,
          label: t('systemPage.myAccess.sections.tokens', 'Tokens'),
          content: <TokensSection ownOnly />,
        },
        {
          id: MY_ACCESS_SECTIONS.preferences,
          label: t('systemPage.myAccess.sections.preferences', 'Preferences'),
          content: <UnitsSection />,
        },
      ]}
    />
  )
}

// ── Profile ──────────────────────────────────────────────────────────

interface ProfileSectionProps {
  readonly user: AuthUser
}

function ProfileSection({ user }: ProfileSectionProps): ReactElement {
  const { t } = useTranslation()
  const isAdmin = user.isAdmin
  const scopes = user.scopes ?? []

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface px-4 py-3 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-base">
          {user.username.slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-foreground truncate">{user.username}</div>
          <div className="text-[11px] text-foreground-subtle">
            {isAdmin
              ? t('systemPage.myAccess.administrator', 'Administrator')
              : t('systemPage.myAccess.user', 'User')}{' '}
            <Trans
              i18nKey="systemPage.myAccess.sessionId"
              values={{ id: user.id.slice(0, 8) }}
              components={{ mono: <span className="font-mono" /> }}
            />
          </div>
        </div>
      </div>

      {/* Admin banner — they bypass the scope-gate entirely. */}
      {isAdmin && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-xs text-foreground flex items-start gap-2.5">
          <Info className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold text-foreground">
              {t('systemPage.myAccess.unrestrictedAccess', 'Unrestricted access')}
            </div>
            <p className="text-foreground-subtle mt-0.5">
              {t(
                'systemPage.myAccess.adminSessionsBypassThePer',
                'Admin sessions bypass the per-call scope check. Every protected endpoint is reachable regardless of the list below.',
              )}
            </p>
          </div>
        </div>
      )}

      {scopes.length > 0 && <GrantedScopes scopes={scopes} />}
    </div>
  )
}

interface GrantedScopesProps {
  readonly scopes: readonly TokenScope[]
}

function GrantedScopes({ scopes }: GrantedScopesProps): ReactElement {
  const { t } = useTranslation()
  const uiText = useUiText()
  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="px-4 py-2 border-b border-border">
        <div className="text-xs font-semibold text-foreground">
          {t('systemPage.myAccess.grantedScopes', 'Granted scopes')}
        </div>
        <div className="text-[10px] text-foreground-subtle">
          {t(
            'systemPage.myAccess.bakedIntoYourSessionToken',
            'Baked into your session token at login; sign out + back in to refresh after changes.',
          )}
        </div>
      </div>
      <div className="grid grid-cols-[100px_1fr_240px] gap-3 px-4 py-2 text-[10px] uppercase tracking-wide text-foreground-subtle border-b border-border">
        <div>{t('systemPage.myAccess.type', 'Type')}</div>
        <div>{t('systemPage.myAccess.target', 'Target')}</div>
        <div>{t('systemPage.myAccess.access', 'Access')}</div>
      </div>
      <ul className="divide-y divide-border">
        {scopes.map((s, idx) => (
          <li
            key={idx}
            className="grid grid-cols-[100px_1fr_240px] gap-3 px-4 py-2.5 items-center text-xs"
          >
            <span className="font-mono text-foreground-subtle">{s.type}</span>
            <span className="font-mono text-foreground">
              {s.type === 'device' ? describeDeviceSelector(s.selector, uiText) : s.target}
            </span>
            <div className="flex items-center gap-1">
              {(['view', 'create', 'delete'] as const).map((a) => {
                const granted = (s.access as readonly TokenScope['access'][number][]).includes(a)
                const { icon: Icon, cls } = ACCESS_META[a]
                return (
                  <span
                    key={a}
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      granted ? cls : 'bg-transparent text-foreground-subtle/40 line-through'
                    }`}
                    title={
                      granted
                        ? t('systemPage.myAccess.can', 'Can {{a}}', { a })
                        : t('systemPage.myAccess.cannot', 'Cannot {{a}}', { a })
                    }
                  >
                    <Icon className="h-3 w-3" />
                    {a}
                  </span>
                )
              })}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
