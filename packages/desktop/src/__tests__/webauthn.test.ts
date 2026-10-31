import { describe, expect, it, vi } from 'vitest'
import {
  answerAccountSelection,
  createDialogChooser,
  parseTeamIdFromInfoPlist,
  touchIdConfigFor,
  type WebAuthnAccountLike,
} from '../role/webauthn'

const A: WebAuthnAccountLike = { credentialId: 'cred-a', name: 'alice' }
const B: WebAuthnAccountLike = { credentialId: 'cred-b', displayName: 'Bob' }

describe('answerAccountSelection', () => {
  it('picks the only account without asking', async () => {
    const cb = vi.fn()
    const choose = vi.fn()
    await answerAccountSelection([A], 'hub.example.com', cb, choose)
    expect(cb).toHaveBeenCalledOnce()
    expect(cb).toHaveBeenCalledWith('cred-a')
    expect(choose).not.toHaveBeenCalled()
  })

  it('asks when several, and answers the chosen one', async () => {
    const cb = vi.fn()
    await answerAccountSelection([A, B], 'h', cb, async () => 1)
    expect(cb).toHaveBeenCalledExactlyOnceWith('cred-b')
  })

  it('cancel is no account, still one call', async () => {
    const cb = vi.fn()
    await answerAccountSelection([A, B], 'h', cb, async () => null)
    expect(cb).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('a throwing chooser still calls back exactly once, with no account', async () => {
    const cb = vi.fn()
    const log = vi.fn()
    await answerAccountSelection(
      [A, B],
      'h',
      cb,
      async () => {
        throw new Error('dialog failed')
      },
      log,
    )
    expect(cb).toHaveBeenCalledExactlyOnceWith(null)
    expect(log).toHaveBeenCalled()
  })

  it('an out-of-range pick cancels', async () => {
    const cb = vi.fn()
    await answerAccountSelection([A, B], 'h', cb, async () => 7)
    expect(cb).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('no accounts answers null', async () => {
    const cb = vi.fn()
    await answerAccountSelection([], 'h', cb, async () => 0)
    expect(cb).toHaveBeenCalledExactlyOnceWith(null)
  })
})

describe('createDialogChooser', () => {
  it('lists one button per account plus Cancel and maps the response', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 })
    const index = await createDialogChooser({ showMessageBox })([A, B], 'h')
    expect(index).toBe(1)
    expect(showMessageBox.mock.calls[0]?.[0].buttons).toEqual(['alice', 'Bob', 'Cancel'])
  })

  it('the Cancel button is null', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 2 })
    expect(await createDialogChooser({ showMessageBox })([A, B], 'h')).toBeNull()
  })
})

describe('team id', () => {
  const plist = (v: string): string =>
    `<dict><key>CamstackTeamId</key>\n<string>${v}</string></dict>`
  it('parses a real team id', () => {
    expect(parseTeamIdFromInfoPlist(plist('ABCDE12345'))).toBe('ABCDE12345')
  })
  it('treats empty or an unexpanded macro as none', () => {
    expect(parseTeamIdFromInfoPlist(plist(''))).toBeNull()
    expect(parseTeamIdFromInfoPlist(plist('${env.APPLE_TEAM_ID}'))).toBeNull()
    expect(parseTeamIdFromInfoPlist('<dict/>')).toBeNull()
  })
  it('builds the access group only with a team id', () => {
    expect(touchIdConfigFor(null)).toBeNull()
    expect(touchIdConfigFor('ABCDE12345')?.keychainAccessGroup).toBe(
      'ABCDE12345.com.camstack.app.webauthn',
    )
  })
})
