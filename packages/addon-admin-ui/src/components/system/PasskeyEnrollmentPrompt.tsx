/**
 * PasskeyEnrollmentPrompt — post-login nudge to save a passkey.
 *
 * Rationale: a passkey enables direct (usernameless) sign-in, but a
 * device WITHOUT the passkey must never lock the user out — so the
 * password flow stays primary and this banner nudges adoption right
 * after a fully-successful password login instead of forcing anything.
 *
 * Visibility — ALL of:
 *   • a real signed-in user (auth context),
 *   • a `kind:'passkey'` arm exists in the public `auth.listLoginMethods`
 *     (= a passkey provider is both installed AND configured — stronger
 *     than the widget-registration check alone, which only proves the
 *     addon bundle is present),
 *   • that arm's effective `rpId` passes the SAME origin gate the login
 *     button uses (`passkeyUsableOnOrigin` — no IP-literal origin, no
 *     hostname/rpId mismatch): a ceremony that's guaranteed to fail
 *     must never be dangled in front of the user,
 *   • the `auth-webauthn/passkey-enrollment` widget is registered
 *     (i.e. a `user-passkeys` provider is installed — cap-driven, the
 *     widget registry is the gate; no addon id branching beyond the
 *     well-known widgetId the "My access" page already references),
 *   • the user has ZERO enrolled passkeys (a user with a passkey on any
 *     device is never prompted — the passkey may simply live elsewhere),
 *   • not dismissed in the last 30 days (localStorage, per userId).
 *
 * [Enroll now] mounts the SAME enrollment widget the "My access" page
 * uses, inline (the whole WebAuthn ceremony ships in the addon bundle).
 * [Not now] persists the dismissal. Because the login page of the
 * native app is this same admin-ui, the nudge serves it automatically.
 */
import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Fingerprint, X } from 'lucide-react'
import { trpc, useSystem, useWidgetMetadata, WidgetSlot } from '@camstack/ui-library'
import { useAuth } from '../../contexts/auth-context'
import { passkeyUsableOnOrigin } from '../login/passkey-gate'
import type { PasskeyLoginMethod } from '../login/PrimaryLoginMethods'

const ENROLLMENT_WIDGET_ID = 'auth-webauthn/passkey-enrollment'
const DISMISS_KEY_PREFIX = 'camstack_passkey_prompt_dismissed:'
const DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000 // ~30 days

function isDismissed(userId: string): boolean {
  try {
    const raw = localStorage.getItem(`${DISMISS_KEY_PREFIX}${userId}`)
    if (!raw) return false
    const at = Number(raw)
    if (!Number.isFinite(at)) return false
    return Date.now() - at < DISMISS_TTL_MS
  } catch {
    return false
  }
}

function persistDismissal(userId: string): void {
  try {
    localStorage.setItem(`${DISMISS_KEY_PREFIX}${userId}`, String(Date.now()))
  } catch {
    /* storage unavailable — the banner just reappears next session */
  }
}

export function PasskeyEnrollmentPrompt() {
  const { user } = useAuth()
  const { t } = useTranslation()
  const system = useSystem()
  const meta = useWidgetMetadata(ENROLLMENT_WIDGET_ID)
  const [dismissed, setDismissed] = useState(false)
  const [enrollOpen, setEnrollOpen] = useState(false)

  const alreadyDismissed = useMemo(
    () => (user ? isDismissed(user.id) : true),
    // Re-evaluate per signed-in identity, not per render.
    [user],
  )

  // Same public procedure the login page reads — a `passkey` arm here
  // means a provider is installed AND configured (not merely bundled).
  const loginMethodsQuery = trpc.auth.listLoginMethods.useQuery()
  const passkeyArm = loginMethodsQuery.data?.find(
    (m): m is PasskeyLoginMethod => m.kind === 'passkey',
  )
  const originGateOk =
    passkeyArm !== undefined && passkeyUsableOnOrigin(window.location.hostname, passkeyArm.rpId)

  const eligible =
    user !== null && originGateOk && meta !== undefined && meta !== null && !alreadyDismissed
  const passkeysQuery = useQuery({
    // Deliberately the SAME key the enrollment widget uses so a
    // successful inline enrollment invalidates this banner too when the
    // widget shares the host query client.
    queryKey: ['auth', 'listOwnPasskeys'],
    queryFn: () => system.listOwnPasskeys(),
    enabled: eligible,
    staleTime: 60_000,
  })

  const dismiss = useCallback(() => {
    if (user) persistDismissal(user.id)
    setDismissed(true)
    setEnrollOpen(false)
  }, [user])

  const closeEnroll = useCallback(() => {
    setEnrollOpen(false)
    void passkeysQuery.refetch()
  }, [passkeysQuery])

  if (!eligible || dismissed) return null
  // Only prompt on CONFIRMED zero passkeys — never flash while loading
  // or on a failed lookup.
  if (passkeysQuery.data === undefined || passkeysQuery.data.length > 0) return null

  return (
    <div className="shrink-0 border-b border-primary/20 bg-primary/5">
      <div className="flex items-center gap-2.5 px-3 py-2 text-xs text-foreground">
        <Fingerprint className="h-4 w-4 text-primary shrink-0" />
        <span className="flex-1 min-w-0">
          {t('passkeyPrompt.message', 'Save a passkey for faster sign-in?')}
        </span>
        <button
          onClick={() => setEnrollOpen((v) => !v)}
          className="rounded bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90"
        >
          {t('passkeyPrompt.enrollNow', 'Enroll now')}
        </button>
        <button
          onClick={dismiss}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-foreground-subtle hover:text-foreground hover:bg-surface-hover"
        >
          {t('passkeyPrompt.notNow', 'Not now')}
        </button>
        <button
          onClick={dismiss}
          aria-label={t('passkeyPrompt.notNow', 'Not now')}
          className="p-1 rounded text-foreground-subtle hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {enrollOpen && (
        <div className="px-3 pb-3">
          <div className="max-w-xl">
            {/* The exact enrollment section "My access" mounts — the whole
                WebAuthn ceremony lives in the addon widget. */}
            <WidgetSlot widgetId={ENROLLMENT_WIDGET_ID} host="dashboard" />
            <div className="mt-2 flex justify-end">
              <button
                onClick={closeEnroll}
                className="rounded border border-border px-2.5 py-1 text-[11px] text-foreground-subtle hover:text-foreground hover:bg-surface-hover"
              >
                {t('common.close', 'Close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
