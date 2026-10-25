/**
 * What the Secrets page needs the operator to know, as ONE ordered list.
 *
 * The page used to stack a banner per condition — the reset notice, the
 * "key shares the backup" paragraph, the missing recovery copy — each with its
 * own box, and they collided on a phone. Now every condition is one short line
 * in a single notice region, ordered by how much it blocks:
 *
 *   locked > reset re-enter list > key shares the backup >
 *   recovery key not taken > rotation pending > orphans
 *
 * Pure: the component decides how each line's action looks.
 */
import type { KeychainResetRecord, KeychainStatus } from '@camstack/types'
import i18n from '../../../i18n/index'

export type KeychainNoticeId =
  | 'locked'
  | 'reset'
  | 'shares-backup'
  | 'recovery-key'
  | 'rotation-pending'
  | 'orphans'

export type KeychainNoticeTone = 'danger' | 'warning' | 'info'

export interface KeychainNotice {
  readonly id: KeychainNoticeId
  readonly tone: KeychainNoticeTone
  /** One line, ≤ 90 characters. Detail lives behind the notice's own toggle. */
  readonly title: string
}

/** Lower first. The order the operator asked for (2026-10-08). */
export const KEYCHAIN_NOTICE_PRIORITY: readonly KeychainNoticeId[] = [
  'locked',
  'reset',
  'shares-backup',
  'recovery-key',
  'rotation-pending',
  'orphans',
]

/** Reason code → catalogue key; an unknown code is shown as it came. */
const LOCKED_REASON_KEY: Readonly<Record<string, string>> = {
  'key-missing': 'helpers.keychainNotices.lockedKeyMissing',
  'wrong-key': 'helpers.keychainNotices.lockedWrongKey',
  'key-file-unreadable': 'helpers.keychainNotices.lockedKeyFileUnreadable',
  'store-unavailable': 'helpers.keychainNotices.lockedStoreUnavailable',
  'not-initialized': 'helpers.keychainNotices.lockedNotInitialized',
  'decrypt-failed': 'helpers.keychainNotices.lockedDecryptFailed',
}

export function lockedReasonText(reason: string): string {
  const key = LOCKED_REASON_KEY[reason]
  return key === undefined ? reason : i18n.t(key)
}

export interface KeychainNoticeInput {
  readonly status: KeychainStatus
  readonly reset: KeychainResetRecord | null
  readonly pendingReentry: number
  readonly orphans: number
}

export function buildKeychainNotices({
  status,
  reset,
  pendingReentry,
  orphans,
}: KeychainNoticeInput): readonly KeychainNotice[] {
  const locked = status.keychain.state === 'locked'
  const source = status.keySource ?? status.configuredSource
  const notices: KeychainNotice[] = []

  if (status.keychain.state === 'locked') {
    notices.push({
      id: 'locked',
      tone: 'danger',
      title: i18n.t('helpers.keychainNotices.locked', {
        reason: lockedReasonText(status.keychain.reason),
      }),
    })
  }
  if (reset !== null && reset.acknowledgedAt === null) {
    notices.push({
      id: 'reset',
      tone: 'danger',
      title:
        pendingReentry > 0
          ? i18n.t('helpers.keychainNotices.resetPending', { count: pendingReentry })
          : i18n.t('helpers.keychainNotices.resetDone'),
    })
  }
  if (source.sharesBackupWithDatabase) {
    notices.push({
      id: 'shares-backup',
      tone: 'warning',
      title: i18n.t('helpers.keychainNotices.sharesBackup'),
    })
  }
  if (!locked && status.recoveryKeyDownloadedAt === null) {
    notices.push({
      id: 'recovery-key',
      tone: 'warning',
      title: i18n.t('helpers.keychainNotices.recoveryKey'),
    })
  }
  if (!locked && status.rotationPending) {
    notices.push({
      id: 'rotation-pending',
      tone: 'info',
      title: i18n.t('helpers.keychainNotices.rotationPending'),
    })
  }
  if (!locked && orphans > 0) {
    notices.push({
      id: 'orphans',
      tone: 'info',
      title: i18n.t('helpers.keychainNotices.orphans', { count: orphans }),
    })
  }

  return [...notices].sort(
    (a, b) => KEYCHAIN_NOTICE_PRIORITY.indexOf(a.id) - KEYCHAIN_NOTICE_PRIORITY.indexOf(b.id),
  )
}
