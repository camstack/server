import { describe, expect, it } from 'vitest'
import { ptyEnvironment } from '../pty.js'
import {
  allowlistedShellEnv,
  hostLooksLikeContainer,
  loginShellBinary,
  serverShellIdleMs,
  serverShellOptIn,
  SERVER_SHELL_IDLE_DEFAULT_MINUTES,
} from '../server-shell.js'

describe('server shell policy', () => {
  it('reads the opt-in only as a strict true', () => {
    expect(serverShellOptIn(true)).toBe(true)
    expect(serverShellOptIn(false)).toBe(false)
    expect(serverShellOptIn(undefined)).toBe(false)
    expect(serverShellOptIn('true')).toBe(false)
  })

  it('uses bash in a container and the login shell on macOS', () => {
    expect(
      loginShellBinary({ platform: 'linux', inContainer: true, shellFromEnv: '/bin/zsh' }),
    ).toBe('/bin/bash')
    expect(
      loginShellBinary({ platform: 'darwin', inContainer: false, shellFromEnv: '/bin/bash' }),
    ).toBe('/bin/bash')
    expect(loginShellBinary({ platform: 'darwin', inContainer: false, shellFromEnv: '  ' })).toBe(
      '/bin/zsh',
    )
    expect(hostLooksLikeContainer(() => false)).toBe(false)
    expect(hostLooksLikeContainer((path) => path === '/.dockerenv')).toBe(true)
  })

  it('copies only the allowlisted environment names', () => {
    expect(
      allowlistedShellEnv({
        PATH: '/usr/bin',
        HOME: '/data',
        USER: 'camstack',
        SECRET_TOKEN: 'nope',
        AWS_SECRET_ACCESS_KEY: 'nope',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/data',
      USER: 'camstack',
      TERM: 'xterm-256color',
    })
  })

  it('defaults the idle window to 30 minutes and clamps the setting', () => {
    expect(serverShellIdleMs(undefined)).toBe(SERVER_SHELL_IDLE_DEFAULT_MINUTES * 60_000)
    expect(serverShellIdleMs(0)).toBe(60_000)
    expect(serverShellIdleMs(45)).toBe(45 * 60_000)
  })

  it('does not let a replaced pty environment inherit a secret', () => {
    expect(
      ptyEnvironment(
        { PATH: '/usr/bin', SECRET_TOKEN: 'nope' },
        { PATH: '/usr/bin', HOME: '/data', TERM: 'xterm-256color' },
        'replace',
      ),
    ).toEqual({ PATH: '/usr/bin', HOME: '/data', TERM: 'xterm-256color' })
  })
})
