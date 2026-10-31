/**
 * "Linked sign-in accounts" — the profile half of D782.
 *
 * An OIDC login signs in ONLY the CamStack user its identity was linked to,
 * and only that user links it, from here: "Link <provider>" asks the hub for
 * a link intent bound to this session and runs the provider sign-in in a
 * popup window (D791) — the popup hands the outcome back and closes, and the
 * list refreshes. A popup that finished on ANOTHER hub address (the IdP
 * returned to a different origin) cannot message this page: its closing
 * refreshes the list, and the link showing up in it is the "linked" notice.
 * A blocked popup navigates the page instead; the hub's SSO
 * finish then brings it back with `?linked=` / `?linkError=`.
 * A link whose provider instance was removed, renamed or disabled stays
 * listed as unavailable and can still be removed.
 */
import { trpc, useConfirm, Button } from '@camstack/ui-library'
import { AlertCircle, CheckCircle, Link2, Loader2, Unlink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { openSsoPopup, watchSsoPopup, withPopupFlag } from '../../lib/sso-popup'
import { type ExternalLinkNotice, externalLinkNotice } from '../../lib/sso-return'
import { hubPath } from '../../lib/mount'
import { useReauthPrompt } from '../auth/ReauthDialog'
import { useTranslation } from 'react-i18next'

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString()
}

export function LinkedSignInsSection() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const providersQuery = trpc.auth.listLinkableProviders.useQuery()
  const linksQuery = trpc.auth.listOwnExternalIdentities.useQuery()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<ExternalLinkNotice | null>(() =>
    externalLinkNotice(window.location.search),
  )
  // The popup the current "Link" press opened (blank until the start URL is
  // minted — opened IN the click so a popup blocker lets it through).
  const popupRef = useRef<Window | null>(null)
  // Linking needs a fresh proof (password or passkey), not just the session.
  const reauth = useReauthPrompt('Linking a sign-in account')
  const stopWatch = useRef<(() => void) | null>(null)
  useEffect(() => () => stopWatch.current?.(), [])
  // The provider a popup is linking: when it appears in the list (however the
  // popup finished), that is the outcome.
  const [pendingProvider, setPendingProvider] = useState<string | null>(null)
  // Read once, then drop the outcome from the URL so a reload does not repeat it.
  useEffect(() => {
    if (notice === null) return
    const url = new URL(window.location.href)
    url.searchParams.delete('linked')
    url.searchParams.delete('linkError')
    window.history.replaceState({}, '', url.pathname + url.search + url.hash)
  }, [notice])

  const begin = trpc.auth.beginExternalLink.useMutation({
    onSuccess: ({ url }) => {
      const popup = popupRef.current
      popupRef.current = null
      if (popup === null || popup.closed) {
        window.location.assign(url)
        return
      }
      const showOutcome = (query: string): void => {
        setPendingProvider(null)
        setNotice(externalLinkNotice(`?${query}`))
        void utils.auth.listOwnExternalIdentities.invalidate()
      }
      stopWatch.current?.()
      stopWatch.current = watchSsoPopup(popup, {
        onReturn: (completion) => {
          if (completion.target === 'profile') showOutcome(completion.query)
        },
        onDone: (signal) => {
          if (signal.target === 'profile') showOutcome(signal.query)
        },
        onClosed: () => {
          stopWatch.current?.()
          stopWatch.current = null
          void utils.auth.listOwnExternalIdentities.invalidate()
        },
      })
      popup.location.href = hubPath(withPopupFlag(url))
    },
    onError: (err) => {
      popupRef.current?.close()
      popupRef.current = null
      setPendingProvider(null)
      setError(err.message)
    },
  })
  const unlink = trpc.auth.unlinkOwnExternalIdentity.useMutation({
    onSuccess: () => void utils.auth.listOwnExternalIdentities.invalidate(),
    onError: (err) => setError(err.message),
  })

  const providers = providersQuery.data ?? []
  const links = linksQuery.data ?? []
  const pendingLinked =
    pendingProvider !== null && links.some((l) => l.provider === pendingProvider)
  useEffect(() => {
    if (!pendingLinked || pendingProvider === null) return
    setPendingProvider(null)
    setNotice({ kind: 'linked', provider: pendingProvider })
  }, [pendingLinked, pendingProvider])
  // Nothing to link and nothing linked: no OIDC provider is configured.
  if (providers.length === 0 && links.length === 0) return null

  const linkedProviders = new Set(links.map((l) => l.provider))
  const labelOf = (provider: string): string =>
    providers.find((p) => p.provider === provider)?.label ?? provider

  const handleUnlink = async (link: { provider: string; subject: string }, label: string) => {
    const ok = await confirm({
      title: t('users.linkedSignInsSection.unlinkSignInAccount', 'Unlink sign-in account'),
      message: t(
        'users.linkedSignInsSection.stopSigningInWithThis',
        'Stop signing in with this {{label}} account?',
        { label },
      ),
      confirmLabel: t('users.linkedSignInsSection.unlink', 'Unlink'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    unlink.mutate({ provider: link.provider, subject: link.subject })
  }

  return (
    <div
      data-testid="linked-sign-ins"
      className="rounded-lg border border-border bg-surface overflow-hidden"
    >
      {reauth.dialog}
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <Link2 className="h-3.5 w-3.5 text-foreground-subtle" />
        <div className="text-xs font-semibold text-foreground">
          {t('users.linkedSignInsSection.linkedSignInAccounts', 'Linked sign-in accounts')}
        </div>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-[11px] text-foreground-subtle">
          {t(
            'users.linkedSignInsSection.signInWithAnExternal',
            'Sign in with an external account instead of your password. Only accounts you link here can sign you in; your two-factor authentication still applies.',
          )}
        </p>

        {notice?.kind === 'linked' && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-foreground">
            <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
            {t('users.linkedSignIns.linkedNotice', { provider: labelOf(notice.provider) })}
          </div>
        )}
        {(notice?.kind === 'error' || error) && (
          <div className="flex items-center gap-2 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error ?? (notice?.kind === 'error' ? notice.message : '')}
          </div>
        )}

        {links.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {links.map((link) => {
              const label = link.providerLabel ?? link.provider
              return (
                <li
                  key={`${link.provider}|${link.subject}`}
                  className="flex items-center gap-3 px-3 py-2 text-xs"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-foreground truncate">
                      {label}
                      {!link.available && (
                        <span className="ml-2 rounded bg-foreground-subtle/15 px-1.5 py-0.5 text-[10px] font-normal text-foreground-subtle">
                          {t(
                            'users.linkedSignInsSection.providerUnavailable',
                            'provider unavailable',
                          )}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-foreground-subtle truncate">
                      {t('users.linkedSignIns.linkedOn', {
                        label: link.label ?? link.subject,
                        date: formatDate(link.linkedAt),
                      })}
                    </div>
                  </div>
                  <Button
                    variant="unstyled"
                    onClick={() => void handleUnlink(link, label)}
                    disabled={unlink.isPending}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] text-danger hover:bg-danger/10 disabled:opacity-50"
                  >
                    <Unlink className="h-3 w-3" />
                    {t('users.linkedSignInsSection.unlink', 'Unlink')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          {providers
            .filter((p) => !linkedProviders.has(p.provider))
            .map((p) => (
              <Button
                variant="unstyled"
                key={p.provider}
                onClick={() => {
                  setError(null)
                  setNotice(null)
                  void reauth.requestProof().then((reauthToken) => {
                    if (reauthToken === null) return
                    // Opened right after the confirm click; a blocker that
                    // refuses it leaves the full-page flow (`begin` handles null).
                    popupRef.current = openSsoPopup(null)
                    setPendingProvider(popupRef.current === null ? null : p.provider)
                    begin.mutate({ provider: p.provider, reauthToken })
                  })
                }}
                disabled={begin.isPending}
                className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-surface-hover disabled:opacity-50"
              >
                {begin.isPending && begin.variables?.provider === p.provider ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Link2 className="h-3 w-3" />
                )}
                {t('users.linkedSignIns.link', { provider: p.label })}
              </Button>
            ))}
        </div>
      </div>
    </div>
  )
}
