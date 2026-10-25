import {
  isSecretFieldView,
  isSecretMarker,
  SECRET_CLEAR,
  type ConfigAccountSignInField,
} from '@camstack/types'
import { useRef, useState, type ReactElement } from 'react'
import { useUiText } from '../contexts/ui-text'
import { Button } from '../primitives/button'
import { Select } from '../primitives/select'

const INPUT_CLASS =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none disabled:opacity-50 disabled:cursor-not-allowed'

const BARE_CODE = /^[A-Za-z0-9._~-]{8,}$/

interface SignInChoice {
  readonly value: string
  readonly label: string
  readonly brand?: string
  readonly region?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPresent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (isSecretFieldView(value) || isSecretMarker(value)) return true
  return false
}

function accountText(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
}

function countFromValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.length
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.length
    } catch {
      return null
    }
  }
  return null
}

function nounFor(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}

function choicesOf(value: unknown): readonly SignInChoice[] {
  if (!Array.isArray(value)) return []
  const out: SignInChoice[] = []
  for (const row of value) {
    if (!isRecord(row) || typeof row['value'] !== 'string' || typeof row['label'] !== 'string') {
      continue
    }
    out.push({
      value: row['value'],
      label: row['label'],
      ...(typeof row['brand'] === 'string' ? { brand: row['brand'] } : {}),
      ...(typeof row['region'] === 'string' ? { region: row['region'] } : {}),
    })
  }
  return out
}

function selectedChoice(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function shouldComplete(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.includes('code=') || trimmed.includes('://') || trimmed.includes('error='))
    return true
  return BARE_CODE.test(trimmed)
}

export function AccountSignInField({
  field,
  values,
  disabled,
  onAction,
  onChangeMany,
}: {
  readonly field: ConfigAccountSignInField
  readonly values: Record<string, unknown>
  readonly disabled?: boolean
  readonly onAction?: (action: string, key: string, value?: unknown) => Promise<unknown>
  readonly onChangeMany?: (patch: Record<string, unknown>) => void
}): ReactElement {
  const t = useUiText()
  const [phase, setPhase] = useState<'idle' | 'pasting'>('idle')
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null)
  const [paste, setPaste] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [choices, setChoices] = useState<readonly SignInChoice[]>([])
  const inFlight = useRef(false)

  const account = accountText(values[field.accountKey])
  const tokenPresent = field.secretKeys.some((key) => isPresent(values[key]))
  const signedIn = account.length > 0 || tokenPresent
  const count =
    (field.countKey !== undefined ? countFromValue(values[field.countKey]) : null) ??
    (field.countFromKey !== undefined ? countFromValue(values[field.countFromKey]) : null)
  const showPaste = phase === 'pasting' || (!signedIn && attemptId !== null)

  const applyResult = (result: Record<string, unknown>): void => {
    const patch: Record<string, unknown> = {}
    for (const [formKey, resultKey] of Object.entries(field.assignResult ?? {})) {
      const assigned = result[resultKey]
      if (typeof assigned === 'string' || typeof assigned === 'number') patch[formKey] = assigned
    }
    if (Object.keys(patch).length > 0) onChangeMany?.(patch)
    const nextChoices = choicesOf(result['choices'])
    setChoices(nextChoices.length > 1 ? nextChoices : [])
    setPhase('idle')
    setPaste('')
    setAttemptId(null)
    setAuthorizeUrl(null)
  }

  const begin = async (): Promise<void> => {
    if (!onAction || working) return
    setWorking(true)
    setError(null)
    try {
      const result = await onAction(field.beginAction, field.key, {})
      if (
        !isRecord(result) ||
        typeof result['authorizeUrl'] !== 'string' ||
        typeof result['attemptId'] !== 'string'
      ) {
        setError(
          t('uiLibrary.accountSignIn.noLink', 'The sign-in page could not be opened. Try again.'),
        )
        return
      }
      if ('verifier' in result || 'state' in result) {
        setError(
          t('uiLibrary.accountSignIn.noLink', 'The sign-in page could not be opened. Try again.'),
        )
        return
      }
      setAttemptId(result['attemptId'])
      setAuthorizeUrl(result['authorizeUrl'])
      setPhase('pasting')
      window.open(result['authorizeUrl'], '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  const complete = async (callback: string): Promise<void> => {
    if (!onAction || attemptId === null || inFlight.current) return
    inFlight.current = true
    setWorking(true)
    setError(null)
    try {
      const result = await onAction(field.completeAction, field.key, { attemptId, callback })
      if (!isRecord(result)) {
        setError(
          t('uiLibrary.accountSignIn.rejected', 'The sign-in was not accepted. Start again.'),
        )
        return
      }
      applyResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.current = false
      setWorking(false)
    }
  }

  const signOut = async (): Promise<void> => {
    if (!onAction || working) return
    setWorking(true)
    setError(null)
    try {
      await onAction(field.signOutAction, field.key, {})
      const patch: Record<string, unknown> = { [field.accountKey]: '' }
      if (field.countKey !== undefined) patch[field.countKey] = 0
      if (field.choiceKey !== undefined) patch[field.choiceKey] = ''
      if (field.countFromKey !== undefined) patch[field.countFromKey] = []
      for (const key of field.secretKeys) patch[key] = SECRET_CLEAR
      onChangeMany?.(patch)
      setChoices([])
      setPhase('idle')
      setAttemptId(null)
      setPaste('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  const pick = (value: string): void => {
    const chosen = choices.find((row) => row.value === value)
    if (chosen === undefined || field.choiceKey === undefined) return
    const patch: Record<string, unknown> = { [field.choiceKey]: chosen.value }
    if (chosen.brand !== undefined) patch['brand'] = chosen.brand
    if (chosen.region !== undefined) patch['region'] = chosen.region
    onChangeMany?.(patch)
  }

  const statusAccount =
    account.length > 0 ? account : t('uiLibrary.accountSignIn.yourAccount', 'your account')
  const status =
    count === null
      ? t('uiLibrary.accountSignIn.signedIn', 'Signed in as {{account}}', {
          account: statusAccount,
        })
      : t('uiLibrary.accountSignIn.signedInCount', 'Signed in as {{account}} · {{detail}}', {
          account: statusAccount,
          detail:
            field.countNoun !== undefined
              ? `${count} ${nounFor(count, field.countNoun)}`
              : String(count),
        })

  return (
    <div className="col-span-1 flex min-w-0 flex-col gap-2">
      {signedIn && phase === 'idle' ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-foreground">{status}</p>
          {choices.length > 1 && field.choiceKey !== undefined && (
            <Select
              aria-label={field.choiceLabel ?? t('uiLibrary.accountSignIn.choose', 'Choose')}
              options={choices.map((row) => ({ value: row.value, label: row.label }))}
              value={selectedChoice(values[field.choiceKey])}
              onChange={(event) => pick(event.target.value)}
              disabled={disabled || working}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || working}
              onClick={() => void begin()}
            >
              {t('uiLibrary.accountSignIn.again', 'Sign in again')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || working}
              onClick={() => void signOut()}
            >
              {t('uiLibrary.accountSignIn.signOut', 'Sign out')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={disabled || working}
          onClick={() => void begin()}
        >
          {working && phase !== 'pasting'
            ? t('uiLibrary.accountSignIn.working', 'Working…')
            : t('uiLibrary.accountSignIn.signInWith', 'Sign in with {{provider}}', {
                provider: field.providerLabel,
              })}
        </Button>
      )}
      {showPaste && (
        <div className="flex flex-col gap-1.5">
          {authorizeUrl !== null && (
            <a
              className="text-[11px] text-primary break-all"
              href={authorizeUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('uiLibrary.accountSignIn.open', 'Open the sign-in page')}
            </a>
          )}
          <textarea
            className={`${INPUT_CLASS} min-h-[60px] resize-y`}
            aria-label={t('uiLibrary.accountSignIn.paste', 'Redirect address or code')}
            placeholder={field.pastePlaceholder}
            value={paste}
            disabled={disabled || working}
            onChange={(event) => {
              const next = event.target.value
              setPaste(next)
              if (shouldComplete(next)) void complete(next)
            }}
          />
        </div>
      )}
      {error !== null && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  )
}

export function SecretPresenceField({
  field,
  values,
}: {
  readonly field: {
    readonly sourceKey: string
    readonly yesLabel: string
    readonly noLabel: string
  }
  readonly values: Record<string, unknown>
}): ReactElement {
  const present = isPresent(values[field.sourceKey])
  return (
    <p className="col-span-1 text-xs text-foreground">{present ? field.yesLabel : field.noLabel}</p>
  )
}
