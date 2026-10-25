/**
 * The Secrets page says what needs attention in ONE ordered list — locked,
 * then the reset's re-enter list, then the key sharing the backup, then the
 * missing recovery copy, then orphans — instead of a stack of banners.
 */
import type { KeychainResetRecord, KeychainStatus } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildKeychainNotices } from '../keychain-notices'

const DEFAULT_SOURCE = {
  kind: 'default-file' as const,
  path: '/data/.keychain/master.key',
  sharesBackupWithDatabase: true,
}
const CONFIG_SOURCE = {
  kind: 'config-file' as const,
  path: '/etc/camstack/master.key',
  sharesBackupWithDatabase: false,
}

const RESET: KeychainResetRecord = {
  id: 'r1',
  at: 1,
  actor: 'trigger-file',
  lockedReason: 'wrong-key',
  archived: 3,
  archivedCollection: 'keychain:secrets-orphaned-1',
  archivedKeysCollection: 'keychain:keys-orphaned-1',
  clearedSettingsKeys: [],
  acknowledgedAt: null,
}

function status(over: Partial<KeychainStatus> = {}): KeychainStatus {
  return {
    keychain: { state: 'ready' },
    keySource: CONFIG_SOURCE,
    configuredSource: CONFIG_SOURCE,
    fingerprint: '0123456789abcdef',
    activeKeyId: 'k1',
    rotationPending: false,
    retiredWraps: 0,
    recoveryKeyDownloadedAt: 5,
    secretCount: 2,
    lastReset: null,
    ...over,
  }
}

const ids = (n: ReturnType<typeof buildKeychainNotices>) => n.map((x) => x.id)

describe('buildKeychainNotices', () => {
  it('a healthy keychain has nothing to say', () => {
    expect(
      buildKeychainNotices({ status: status(), reset: null, pendingReentry: 0, orphans: 0 }),
    ).toEqual([])
  })

  it('orders every notice by priority', () => {
    const notices = buildKeychainNotices({
      status: status({
        keySource: DEFAULT_SOURCE,
        configuredSource: DEFAULT_SOURCE,
        recoveryKeyDownloadedAt: null,
        rotationPending: true,
      }),
      reset: RESET,
      pendingReentry: 2,
      orphans: 3,
    })
    expect(ids(notices)).toEqual([
      'reset',
      'shares-backup',
      'recovery-key',
      'rotation-pending',
      'orphans',
    ])
  })

  it('a locked keychain leads, and suppresses what cannot be acted on while locked', () => {
    const notices = buildKeychainNotices({
      status: status({
        keychain: { state: 'locked', reason: 'wrong-key' },
        keySource: null,
        configuredSource: DEFAULT_SOURCE,
        recoveryKeyDownloadedAt: null,
      }),
      reset: RESET,
      pendingReentry: 1,
      orphans: 4,
    })
    expect(ids(notices)[0]).toBe('locked')
    expect(ids(notices)).not.toContain('recovery-key')
    expect(ids(notices)).not.toContain('orphans')
    expect(notices[0]?.tone).toBe('danger')
  })

  it('an acknowledged reset is not a notice', () => {
    const notices = buildKeychainNotices({
      status: status(),
      reset: { ...RESET, acknowledgedAt: 9 },
      pendingReentry: 4,
      orphans: 0,
    })
    expect(ids(notices)).toEqual([])
  })

  it('each notice is one short line', () => {
    const notices = buildKeychainNotices({
      status: status({
        keySource: DEFAULT_SOURCE,
        configuredSource: DEFAULT_SOURCE,
        recoveryKeyDownloadedAt: null,
      }),
      reset: RESET,
      pendingReentry: 2,
      orphans: 1,
    })
    for (const n of notices) expect(n.title.length).toBeLessThanOrEqual(90)
    expect(notices.find((n) => n.id === 'reset')?.title).toMatch(/2 fields to re-enter/)
    expect(notices.find((n) => n.id === 'orphans')?.title).toMatch(/1 stored value/)
  })
})
