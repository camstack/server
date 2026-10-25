/**
 * Constructor defaults are `mode: 'quick'`. A store that has not answered
 * therefore looks exactly like "the operator wants a trycloudflare URL".
 * Auto-starting that is how `camstack.<local-user>.top` went 530: the
 * named tunnel never came up, notifications still minted the marked hostname.
 */
import { describe, expect, it } from 'vitest'
import { shouldAutoStartTunnel } from '../auto-start.js'

describe('shouldAutoStartTunnel', () => {
  it('refuses to start when the settings store never answered — defaults are not an operator choice', () => {
    expect(
      shouldAutoStartTunnel({
        settingsStoreReady: false,
        mode: 'quick',
        hasCustomToken: false,
        hasCustomHostname: false,
      }),
    ).toBe(false)
  })

  it('auto-starts a quick tunnel only after the store has answered', () => {
    expect(
      shouldAutoStartTunnel({
        settingsStoreReady: true,
        mode: 'quick',
        hasCustomToken: false,
        hasCustomHostname: false,
      }),
    ).toBe(true)
  })

  it('auto-starts a named tunnel when the store answered with a token and hostname', () => {
    expect(
      shouldAutoStartTunnel({
        settingsStoreReady: true,
        mode: 'custom',
        hasCustomToken: true,
        hasCustomHostname: true,
      }),
    ).toBe(true)
  })

  it('does not auto-start custom mode with a missing token even if the store answered', () => {
    expect(
      shouldAutoStartTunnel({
        settingsStoreReady: true,
        mode: 'custom',
        hasCustomToken: false,
        hasCustomHostname: true,
      }),
    ).toBe(false)
  })
})
