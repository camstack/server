/**
 * Approve a terminal sign-in (D988): the operator types the short code a
 * terminal printed, sees who asked (address, client, how long ago) and
 * approves or denies. The code is never taken from the URL, so a link cannot
 * pre-fill it: only someone reading it off their own terminal can approve.
 */
import { Button, Input, trpc } from '@camstack/ui-library'
import { Loader2, TerminalSquare } from 'lucide-react'
import { useState, type FormEvent, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useReauthPrompt } from './ReauthDialog'

export interface CliLoginRequestView {
  readonly requestId: string
  readonly ip: string | null
  /** Self-reported by the terminal: unverified. */
  readonly client: string | null
  /** The User-Agent the hub saw. */
  readonly userAgent: string | null
  readonly createdAt: number
  readonly expiresAt: number
}

/** What `cliLoginDescribe` answers: the request plus the approver's own address. */
export interface CliLoginDescribeView extends CliLoginRequestView {
  readonly approverIp: string | null
}

/** Known and different: the request came from somewhere other than where the operator is. */
export function addressMismatch(view: CliLoginDescribeView): boolean {
  return view.ip !== null && view.approverIp !== null && view.ip !== view.approverIp
}

export interface CliLoginApprovalProps {
  /** Called after an approval, when the terminal is about to be signed in. */
  readonly onApproved: () => void
  /** Called after a denial. */
  readonly onDenied: () => void
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback
}

function needsFreshSignIn(err: unknown): boolean {
  const message = err instanceof Error ? err.message : ''
  return message.startsWith('Sign in again first') || message.startsWith('Confirm it is you')
}

/** "just now" / "42 s ago" / "3 min ago" — the request is at most five minutes old. */
export function requestAge(createdAt: number, now: number): { key: string; value: number } {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000))
  if (seconds < 5) return { key: 'justNow', value: 0 }
  if (seconds < 60) return { key: 'seconds', value: seconds }
  return { key: 'minutes', value: Math.round(seconds / 60) }
}

export function CliLoginApproval({ onApproved, onDenied }: CliLoginApprovalProps): JSX.Element {
  const { t } = useTranslation()
  const utils = trpc.useUtils()
  const [code, setCode] = useState('')
  const [request, setRequest] = useState<CliLoginDescribeView | null>(null)
  const [confirmedCode, setConfirmedCode] = useState('')
  const [busy, setBusy] = useState<'lookup' | 'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { requestProof, dialog } = useReauthPrompt(
    t('cliLogin.reauthAction', 'Approving a terminal sign-in'),
  )
  const approve = trpc.auth.cliLoginApprove.useMutation()
  const deny = trpc.auth.cliLoginDeny.useMutation()

  const lookup = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy('lookup')
    setError(null)
    try {
      const view = await utils.auth.cliLoginDescribe.fetch({ userCode: code })
      setRequest(view)
      setConfirmedCode(code)
    } catch (err) {
      setRequest(null)
      setError(
        errorText(
          err,
          t('cliLogin.unknownCode', 'No pending sign-in with that code. Check the terminal.'),
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  const decide = async (kind: 'approve' | 'deny'): Promise<void> => {
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'deny') {
        await deny.mutateAsync({ userCode: confirmedCode })
        onDenied()
        return
      }
      try {
        await approve.mutateAsync({ userCode: confirmedCode })
      } catch (err) {
        if (!needsFreshSignIn(err)) throw err
        const reauthToken = await requestProof()
        if (reauthToken === null) return
        await approve.mutateAsync({ userCode: confirmedCode, reauthToken })
      }
      onApproved()
    } catch (err) {
      setError(errorText(err, t('cliLogin.failed', 'That did not work. Try again.')))
    } finally {
      setBusy(null)
    }
  }

  const age = request === null ? null : requestAge(request.createdAt, Date.now())

  return (
    <div className="space-y-4" data-testid="cli-login-approval">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <TerminalSquare className="h-4 w-4" aria-hidden />
          {t('cliLogin.title', 'Approve a terminal sign-in')}
        </h1>
        <p className="text-xs text-foreground-subtle">
          {t(
            'cliLogin.intro',
            'Type the code your terminal shows. Only approve a sign-in you started yourself.',
          )}
        </p>
      </div>

      {error !== null && (
        <div
          role="alert"
          className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}

      {request === null || age === null ? (
        <form onSubmit={(e) => void lookup(e)} className="space-y-3">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCD-EFGH"
            aria-label={t('cliLogin.codeLabel', 'Sign-in code')}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={16}
            className="text-center font-mono tracking-widest"
          />
          <Button
            type="submit"
            variant="primary"
            className="w-full"
            disabled={code.trim().length < 8 || busy !== null}
          >
            {busy === 'lookup' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t('cliLogin.continue', 'Continue')}
          </Button>
        </form>
      ) : (
        <div className="space-y-3">
          <dl className="space-y-1 rounded-md border border-border bg-background-elevated p-3 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-foreground-muted">{t('cliLogin.address', 'Terminal address')}</dt>
              <dd className="text-foreground" data-testid="cli-login-ip">
                {request.ip ?? t('cliLogin.unknownValue', 'Unknown')}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-foreground-muted">{t('cliLogin.yourAddress', 'Your address')}</dt>
              <dd className="text-foreground" data-testid="cli-login-approver-ip">
                {request.approverIp ?? t('cliLogin.unknownValue', 'Unknown')}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-foreground-muted">
                {t('cliLogin.program', 'Program (seen by the hub)')}
              </dt>
              <dd className="truncate text-foreground" data-testid="cli-login-agent">
                {request.userAgent ?? t('cliLogin.unknownValue', 'Unknown')}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-foreground-muted">
                {t('cliLogin.client', 'Name it gave itself (unverified)')}
              </dt>
              <dd className="truncate text-foreground-muted" data-testid="cli-login-client">
                {request.client ?? t('cliLogin.unknownValue', 'Unknown')}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-foreground-muted">{t('cliLogin.requested', 'Requested')}</dt>
              <dd className="text-foreground">
                {age.key === 'justNow'
                  ? t('cliLogin.ageNow', 'just now')
                  : age.key === 'seconds'
                    ? t('cliLogin.ageSeconds', '{{count}} s ago', { count: age.value })
                    : t('cliLogin.ageMinutes', '{{count}} min ago', { count: age.value })}
              </dd>
            </div>
          </dl>
          {addressMismatch(request) && (
            <div
              role="alert"
              data-testid="cli-login-mismatch"
              className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning"
            >
              {t(
                'cliLogin.mismatch',
                'This request comes from a different address than the one you are using now. Approve it only if you started it from another machine of yours.',
              )}
            </div>
          )}
          <p className="text-xs text-foreground-subtle" data-testid="cli-login-grant">
            {t(
              'cliLogin.grant',
              'Approving signs this terminal in as you, with all of your rights, until the session expires or you end it under Tokens & sessions.',
            )}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              className="flex-1"
              disabled={busy !== null}
              onClick={() => void decide('deny')}
            >
              {t('cliLogin.deny', 'Deny')}
            </Button>
            <Button
              type="button"
              variant="primary"
              className="flex-1"
              disabled={busy !== null}
              onClick={() => void decide('approve')}
            >
              {busy === 'approve' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {t('cliLogin.approve', 'Approve')}
            </Button>
          </div>
        </div>
      )}
      {dialog}
    </div>
  )
}
