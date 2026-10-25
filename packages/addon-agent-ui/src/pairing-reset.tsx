/**
 * "Reset pairing lockout" (D857): clears the wrong-PIN lockouts, the offer budget
 * and every pending offer. From the agent's own machine nothing is asked; from
 * anywhere else the reset code printed at boot is required.
 */
import { Button, FormField, Input } from '@camstack/ui-library'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useT } from './i18n'
import { PAIRING_PIN_DIGITS, PAIRING_RESET_PATH, describeFailure, sendPairing } from './pairing-api'

interface PairingResetProps {
  /** On this machine the reset code is not asked. */
  readonly local: boolean
  /** Called after a successful reset so the caller can re-read the pairing status. */
  readonly onReset: () => Promise<void>
}

export function PairingReset({ local, onReset }: PairingResetProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  // The server decides who is local; if it asks for the code anyway, ask for it.
  const [needCode, setNeedCode] = useState(false)
  const askCode = !local || needCode
  const [message, setMessage] = useState<{
    readonly text: string
    readonly ok: boolean
  } | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    const outcome = await sendPairing(PAIRING_RESET_PATH, askCode ? { code: code.trim() } : {})
    setBusy(false)
    if (outcome.ok) {
      setCode('')
      setMessage({
        ok: true,
        text: t('reset.done'),
      })
      await onReset()
      return
    }
    if (outcome.error === 'reset-code-required') setNeedCode(true)
    setMessage({ ok: false, text: describeFailure(outcome) })
  }

  return (
    <div className="border-t border-border pt-3 space-y-3">
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
        <RotateCcw className="h-3 w-3" />
        {open ? t('reset.hide') : t('reset.show')}
      </Button>
      {open && (
        <div className="space-y-3">
          <p className="text-[11px] text-foreground-subtle">{t('reset.explain')}</p>
          {!askCode ? (
            <p className="text-[11px] text-foreground-subtle">{t('reset.noCodeNeeded')}</p>
          ) : (
            <FormField label={t('reset.codeLabel')} description={t('reset.codeHelp')}>
              <Input
                id="agent-pairing-reset-code"
                aria-label={t('reset.codeLabel')}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PAIRING_PIN_DIGITS}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('reset.codePlaceholder')}
              />
            </FormField>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || (askCode && code.trim().length === 0)}
            onClick={() => void submit()}
          >
            {busy ? t('reset.resetting') : t('reset.submit')}
          </Button>
          {message !== null && (
            <p
              role="status"
              className={message.ok ? 'text-[11px] text-success' : 'text-[11px] text-danger'}
            >
              {message.text}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
