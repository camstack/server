/**
 * The action and the "Details" text of each keychain notice line.
 *
 * The reset's detail is what the stand-alone reset banner used to say: who
 * reset it and when (the page's Reset or the RESET_KEYCHAIN trigger file), what
 * was archived, and the fields that
 * still read "not set" — owner, scope, field, never a value.
 */
import {
  KEYCHAIN_RESET_TRIGGER_ACTOR,
  type KeychainResetRecord,
  type KeychainSecretMeta,
} from '@camstack/types'
import { Button } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { formatWhen } from './format'
import type { KeychainNoticeId } from './keychain-notices'
import i18n from '../../../i18n/index'

export interface NoticeContext {
  readonly reset: KeychainResetRecord | null
  readonly pendingReentry: readonly KeychainSecretMeta[]
  readonly busy: boolean
  readonly onReset: () => void
  readonly onAcknowledgeReset: () => void
  readonly onDownload: () => void
  readonly onRotate: () => void
  readonly onShowOrphans: () => void
}

export function noticeAction(id: KeychainNoticeId, ctx: NoticeContext): ReactNode {
  switch (id) {
    case 'locked':
      return (
        <Button size="sm" variant="danger" disabled={ctx.busy} onClick={ctx.onReset}>
          {i18n.t('secrets.keychainNoticeContent.resetKeychain', 'Reset keychain')}
        </Button>
      )
    case 'reset':
      return (
        <Button size="sm" variant="outline" disabled={ctx.busy} onClick={ctx.onAcknowledgeReset}>
          {i18n.t('secrets.keychainNoticeContent.dismiss', 'Dismiss')}
        </Button>
      )
    case 'recovery-key':
      return (
        <Button size="sm" variant="outline" disabled={ctx.busy} onClick={ctx.onDownload}>
          {i18n.t('secrets.keychainNoticeContent.download', 'Download')}
        </Button>
      )
    case 'rotation-pending':
      return (
        <Button size="sm" variant="outline" disabled={ctx.busy} onClick={ctx.onRotate}>
          {i18n.t('secrets.keychainNoticeContent.rotate', 'Rotate')}
        </Button>
      )
    case 'orphans':
      return (
        <Button size="sm" variant="outline" onClick={ctx.onShowOrphans}>
          {i18n.t('secrets.keychainNoticeContent.review', 'Review')}
        </Button>
      )
    case 'shares-backup':
      return null
  }
}

export function noticeDetail(id: KeychainNoticeId, ctx: NoticeContext): ReactNode {
  switch (id) {
    case 'locked':
      return (
        <p>
          {i18n.t(
            'secrets.keychainNoticeContent.noValueCanBeRead',
            'No value can be read or stored. If the master key is lost for good, Reset archives every stored value and starts a new keychain; every secret field then reads “not set”.',
          )}
        </p>
      )
    case 'reset':
      return ctx.reset === null ? null : (
        <ResetDetail reset={ctx.reset} pending={ctx.pendingReentry} />
      )
    case 'shares-backup':
      return (
        <p>
          <Trans
            i18nKey="secrets.keychainNoticeContent.backupKeyFile"
            components={{ code: <code className="font-mono" /> }}
          />
        </p>
      )
    case 'recovery-key':
      return (
        <p>
          {i18n.t(
            'secrets.keychainNoticeContent.withoutACopyOfThe',
            'Without a copy of the master key, the stored values cannot be recovered.',
          )}
        </p>
      )
    case 'rotation-pending':
      return (
        <p>
          {i18n.t(
            'secrets.keychainNoticeContent.theKeychainUnlockedWithA',
            'The keychain unlocked with a previous key. Rotate to move onto the configured one.',
          )}
        </p>
      )
    case 'orphans':
      return null
  }
}

export function ResetDetail({
  reset,
  pending,
}: {
  readonly reset: KeychainResetRecord
  readonly pending: readonly KeychainSecretMeta[]
}) {
  const { t } = useTranslation()
  const by =
    reset.actor === KEYCHAIN_RESET_TRIGGER_ACTOR
      ? t('secrets.keychainNoticeContent.resetByTrigger')
      : t('secrets.keychainNoticeContent.resetByAdmin', { actor: reset.actor })
  return (
    <div className="space-y-1.5">
      <p>
        {t('secrets.keychainNoticeContent.resetDetail', {
          when: formatWhen(reset.at),
          by,
          archived: reset.archived,
        })}
      </p>
      {pending.length > 0 && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground">
          {pending.map((m) => (
            <li key={m.ref} className="break-all">
              {m.owner} · {m.scope} · {m.fieldPath}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
