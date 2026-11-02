import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The four answers a connection test can give. `validated` and `rejected` are
 * things the remote actually said; `inconclusive` and `unsupported` are things
 * nobody said, and they must NOT render as either a tick or a failure — the
 * operator has to be able to tell "your password is wrong" from "we never got
 * to ask".
 */
export type TestStatus = 'validated' | 'rejected' | 'inconclusive' | 'unsupported'

export interface TestVerdict {
  readonly status: TestStatus
  readonly error?: string
  readonly detail?: string
}

/** Older servers answer with `success` only; treat that as the binary it was. */
export function toTestVerdict(result: {
  success: boolean
  error?: string
  status?: string
  detail?: string
}): TestVerdict {
  const status: TestStatus =
    result.status === 'validated' ||
    result.status === 'rejected' ||
    result.status === 'inconclusive' ||
    result.status === 'unsupported'
      ? result.status
      : result.success
        ? 'validated'
        : 'rejected'
  return {
    status,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
  }
}

const TONE: Record<TestStatus, string> = {
  validated: 'border-success/30 bg-success/5 text-success',
  rejected: 'border-danger/30 bg-danger/5 text-danger',
  // Deliberately NOT red: nothing failed. A neutral/attention tone, so
  // "could not check" never reads as "wrong password".
  inconclusive: 'border-warning/30 bg-warning/5 text-warning',
  unsupported: 'border-border bg-surface text-foreground-subtle',
}

export function TestVerdictBanner({ verdict }: { readonly verdict: TestVerdict }): ReactElement {
  const { t } = useTranslation()
  const text = ((): string => {
    switch (verdict.status) {
      case 'validated':
        return verdict.detail
          ? `${t('integrations.connectionSuccess')} — ${verdict.detail}`
          : t('integrations.connectionSuccess')
      case 'rejected':
        return `${t('integrations.errorPrefix')} ${verdict.error ?? ''}`
      case 'inconclusive':
        return `${t('integrations.connectionInconclusive', {
          defaultValue: 'Could not be checked:',
        })} ${verdict.error ?? ''}`
      case 'unsupported':
        return (
          verdict.error ??
          t('integrations.connectionUntestable', {
            defaultValue: 'This integration cannot be tested before it is created.',
          })
        )
    }
  })()
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs ${TONE[verdict.status]}`}
      data-testid="connection-test-verdict"
    >
      {text}
    </div>
  )
}
