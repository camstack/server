/**
 * "Confirm it's you" — the re-authentication prompt in front of the sensitive
 * self-service actions (linking a sign-in account, disabling 2FA, removing a
 * passkey, creating an admin token). The current password, or a passkey;
 * answers the hub's 5-minute proof (`auth.reauthenticate`).
 *
 * `useReauthPrompt()` returns `requestProof()` — resolves with the proof, or
 * `null` when the user cancels — and the `dialog` element the caller renders.
 */
import { startAuthentication } from '@simplewebauthn/browser'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  useSystem,
} from '@camstack/ui-library'
import { KeyRound, Loader2 } from 'lucide-react'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isPasskeyAuthenticationOptions } from '../../lib/passkey-wire.js'

export interface ReauthPrompt {
  /** Ask for a proof; `null` when cancelled. */
  readonly requestProof: () => Promise<string | null>
  /** Render this somewhere in the caller's tree. */
  readonly dialog: ReactNode
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback
}

export function useReauthPrompt(action: string): ReauthPrompt {
  const { t } = useTranslation()
  const system = useSystem()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'password' | 'passkey' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<((proof: string | null) => void) | null>(null)

  const settle = useCallback((proof: string | null) => {
    pending.current?.(proof)
    pending.current = null
    setOpen(false)
    setPassword('')
    setBusy(null)
    setError(null)
  }, [])

  const requestProof = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        pending.current?.(null)
        pending.current = resolve
        setError(null)
        setOpen(true)
      }),
    [],
  )

  const withPassword = async (): Promise<void> => {
    setBusy('password')
    setError(null)
    try {
      const { reauthToken } = await system.reauthenticate({ password })
      settle(reauthToken)
    } catch (err: unknown) {
      setError(message(err, 'Password is incorrect'))
      setBusy(null)
    }
  }

  const withPasskey = async (): Promise<void> => {
    setBusy('passkey')
    setError(null)
    try {
      const { optionsJSON } = await system.reauthBeginPasskey()
      if (!isPasskeyAuthenticationOptions(optionsJSON)) {
        throw new Error('passkey authentication options missing challenge')
      }
      const assertion = await startAuthentication({ optionsJSON })
      const { reauthToken } = await system.reauthenticate({
        passkeyResponse: Object.fromEntries(Object.entries(assertion)),
      })
      settle(reauthToken)
    } catch (err: unknown) {
      setError(message(err, 'Passkey verification failed'))
      setBusy(null)
    }
  }

  const dialog = (
    <Dialog open={open} onOpenChange={(next) => !next && settle(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('auth.reauthDialog.confirmItSYou', 'Confirm it’s you')}</DialogTitle>
          <DialogDescription>{t('auth.reauthDialog.needsPassword', { action })}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (password.length > 0 && busy === null) void withPassword()
          }}
        >
          <Input
            type="password"
            autoComplete="current-password"
            placeholder={t('auth.reauthDialog.currentPassword', 'Current password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label={t('auth.reauthDialog.currentPassword', 'Current password')}
          />
          {error !== null && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <DialogFooter className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void withPasskey()}
            >
              {busy === 'passkey' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              {t('auth.reauthDialog.useAPasskey', 'Use a passkey')}
            </Button>
            <Button type="submit" disabled={password.length === 0 || busy !== null}>
              {busy === 'password' && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('common.confirm', 'Confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )

  return { requestProof, dialog }
}
