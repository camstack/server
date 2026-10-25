// @vitest-environment jsdom
/**
 * After a keychain reset (the RESET_KEYCHAIN trigger file, or the page's own
 * Reset), the reset notice's details say who reset it and list the fields
 * that still read "not set" — never a value. (Was KeychainResetNotice.spec.)
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ResetDetail } from '../KeychainNoticeContent'

const RESET = {
  id: 'r1',
  at: Date.UTC(2026, 9, 9, 10, 0),
  actor: 'trigger-file',
  lockedReason: 'wrong-key',
  archived: 3,
  archivedCollection: 'keychain:secrets-orphaned-1',
  archivedKeysCollection: 'keychain:keys-orphaned-1',
  clearedSettingsKeys: [],
  acknowledgedAt: null,
}

const PENDING = {
  ref: 'secret://cloudflare-tunnel/global/customApiToken',
  owner: 'cloudflare-tunnel',
  scope: 'global',
  fieldPath: 'customApiToken',
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'addon:cloudflare-tunnel',
  lastReadAt: null,
}

describe('ResetDetail', () => {
  it('names the trigger file and what to re-enter, and no cluster secret (D857)', () => {
    const { container } = render(<ResetDetail reset={RESET} pending={[PENDING]} />)
    const text = container.textContent ?? ''
    expect(text).toMatch(/RESET_KEYCHAIN trigger file/)
    expect(text).not.toMatch(/cluster secret/i)
    expect(text).toContain('cloudflare-tunnel · global · customApiToken')
  })

  it('names the admin when the page reset it', () => {
    const { container } = render(<ResetDetail reset={{ ...RESET, actor: 'user:7' }} pending={[]} />)
    expect(container.textContent).toMatch(/an admin \(user:7\)/)
  })
})
