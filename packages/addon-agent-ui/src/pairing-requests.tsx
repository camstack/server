/**
 * The pairing request screen (D857): a hub asked to pair with this agent and
 * the operator confirms it HERE, as well as on the hub.
 *
 * Both screens must show the same six digits, so the operator types the code
 * the HUB displays; this page never shows or prefills a code. Away from the
 * agent's machine the one-time PIN printed on that machine is required too
 * (it proves the person at this page is at the agent). On the agent's own
 * machine (the status view then carries the PIN) the field is hidden.
 */
import { Badge, Button, ErrorBox, FormField, Input } from '@camstack/ui-library'
import { Check, ShieldQuestion, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Trans, useT } from './i18n'
import {
  PAIRING_CODE_DIGITS,
  PAIRING_CONFIRM_PATH,
  PAIRING_PIN_DIGITS,
  PAIRING_REJECT_PATH,
  type PairingFailureBody,
  type PendingPairing,
  describeFailure,
  formatCountdown,
  formatWait,
  groupFingerprint,
  isLoopbackView,
  sendPairing,
} from './pairing-api'

const LOCK_ERRORS: ReadonlySet<string> = new Set(['pin-locked', 'reset-locked'])

/** Identity of one pending pairing: one per hub CA. */
function keyOf(pairing: PendingPairing): string {
  return pairing.hub.caFingerprint
}

function HubIdentity({ pairing }: { readonly pairing: PendingPairing }) {
  return (
    <div className="space-y-0.5 min-w-0">
      <div className="text-xs text-foreground">
        <Trans
          i18nKey="requests.requestFrom"
          values={{ node: pairing.hub.nodeId }}
          components={{ b: <span className="font-semibold" /> }}
        />
      </div>
      <div className="text-[11px] font-mono text-foreground-subtle break-all">
        {pairing.hub.url}
      </div>
      <div className="text-[11px] text-foreground-subtle">
        <Trans
          i18nKey="requests.caFingerprint"
          values={{ fingerprint: groupFingerprint(pairing.hub.caFingerprint) }}
          components={{ mono: <span className="font-mono break-all" /> }}
        />
      </div>
    </div>
  )
}

interface PairingRequestsProps {
  readonly pending: readonly PendingPairing[]
  /** Re-read the pairing status now. */
  readonly onChanged: () => Promise<void>
}

export function PairingRequests({ pending, onChanged }: PairingRequestsProps) {
  const { t } = useT()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [lockedUntil, setLockedUntil] = useState<number | null>(null)
  const [confirmed, setConfirmed] = useState<readonly string[]>([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  const selected = pending.find((p) => keyOf(p) === selectedKey) ?? pending[0]
  const loopback = isLoopbackView(pending)
  const locked = lockedUntil !== null && lockedUntil > now

  if (selected === undefined) return null
  const selectedId = keyOf(selected)
  const confirmedHere = selected.localConfirmed === true || confirmed.includes(selectedId)

  const select = (key: string): void => {
    if (key === selectedId) return
    // A code typed for one hub is never carried to another.
    setSelectedKey(key)
    setCode('')
    setFeedback(null)
  }

  const identify = (): Record<string, unknown> =>
    loopback ? { pin: selected.pin ?? '' } : { pin: pin.trim() }

  const noteFailure = (failure: PairingFailureBody): void => {
    setFeedback(describeFailure(failure))
    if (failure.retryAfterMs !== undefined && LOCK_ERRORS.has(failure.error ?? '')) {
      const at = Date.now()
      setNow(at)
      setLockedUntil(at + failure.retryAfterMs)
    }
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setFeedback(null)
    const outcome = await sendPairing(PAIRING_CONFIRM_PATH, {
      ...identify(),
      code: code.trim(),
    })
    setBusy(false)
    setCode('')
    if (outcome.ok) {
      setConfirmed((prev) => [...prev, selectedId])
      setPin('')
      await onChanged()
      return
    }
    noteFailure(outcome)
    await onChanged()
  }

  const reject = async (): Promise<void> => {
    setBusy(true)
    setFeedback(null)
    const outcome = await sendPairing(PAIRING_REJECT_PATH, identify())
    setBusy(false)
    if (!outcome.ok) noteFailure(outcome)
    setCode('')
    await onChanged()
  }

  const canConfirm =
    !busy &&
    !locked &&
    code.trim().length === PAIRING_CODE_DIGITS &&
    (loopback || pin.trim().length === PAIRING_PIN_DIGITS)
  const canReject = !busy && !locked && (loopback || pin.trim().length === PAIRING_PIN_DIGITS)

  return (
    <div className="space-y-3">
      {pending.length > 1 && (
        <div className="space-y-1" role="radiogroup" aria-label={t('requests.pendingGroup')}>
          <div className="text-[10px] uppercase tracking-wider text-foreground-subtle font-medium">
            {t('requests.pickOne', { count: pending.length })}
          </div>
          {pending.map((p) => (
            <Button
              key={keyOf(p)}
              type="button"
              role="radio"
              aria-checked={keyOf(p) === selectedId}
              variant={keyOf(p) === selectedId ? 'primary' : 'outline'}
              size="sm"
              className="w-full justify-start text-left h-auto py-1.5"
              onClick={() => select(keyOf(p))}
            >
              <span className="min-w-0 truncate">
                {p.hub.nodeId} · {p.hub.url}
              </span>
            </Button>
          ))}
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <ShieldQuestion className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
          <HubIdentity pairing={selected} />
        </div>
        <Badge variant="warning" className="shrink-0 font-mono" title={t('requests.timeLeft')}>
          {formatCountdown(selected.expiresAt, now)}
        </Badge>
      </div>

      {locked && lockedUntil !== null && (
        <ErrorBox
          variant="warning"
          title={t('requests.lockedTitle')}
          message={t('requests.lockedMessage', { wait: formatWait(lockedUntil - now) })}
        />
      )}

      {confirmedHere ? (
        <div className="space-y-2">
          <Badge variant="success" icon={<Check className="h-3 w-3" />}>
            {t('requests.confirmedHere')}
          </Badge>
          <p className="text-[11px] text-foreground-subtle">{t('requests.confirmedHint')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <FormField
            label={t('requests.codeLabel')}
            description={t('requests.codeHelp', { digits: PAIRING_CODE_DIGITS })}
          >
            <Input
              id="agent-pairing-code"
              aria-label={t('requests.codeLabel')}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              maxLength={PAIRING_CODE_DIGITS}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="font-mono tracking-widest"
              disabled={locked}
            />
          </FormField>
          {!loopback && (
            <FormField label={t('requests.pinLabel')} description={t('requests.pinHelp')}>
              <Input
                id="agent-pairing-pin"
                aria-label={t('requests.pinLabel')}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PAIRING_PIN_DIGITS}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                placeholder={t('requests.pinPlaceholder')}
                className="font-mono tracking-widest"
                disabled={locked}
              />
            </FormField>
          )}
          {loopback && (
            <p className="text-[11px] text-foreground-subtle">{t('requests.noPinNeeded')}</p>
          )}
        </div>
      )}

      {feedback !== null && (
        <p role="alert" className="text-[11px] text-danger">
          {feedback}
        </p>
      )}

      <div className="flex items-center gap-2">
        {!confirmedHere && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canConfirm}
            onClick={() => void confirm()}
          >
            <Check className="h-3 w-3" />
            {t('requests.confirm')}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canReject}
          onClick={() => void reject()}
        >
          <X className="h-3 w-3" />
          {t('requests.reject')}
        </Button>
      </div>
    </div>
  )
}
