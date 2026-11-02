import { shouldAcceptSleepPushSource } from '@apocaliss92/nodelink-js'
import { describe, expect, it } from 'vitest'
import { resolveBatterySleepPushMethod } from '../baichuan-webhook-shared.js'

describe('resolveBatterySleepPushMethod', () => {
  it('auto prefers webhook when supported', () => {
    expect(resolveBatterySleepPushMethod('auto', true)).toBe('webhook')
    expect(resolveBatterySleepPushMethod(undefined, true)).toBe('webhook')
  })

  it('auto falls back to email when unsupported', () => {
    expect(resolveBatterySleepPushMethod('auto', false)).toBe('email')
  })

  it('honours an explicit preference', () => {
    expect(resolveBatterySleepPushMethod('email', true)).toBe('email')
    expect(resolveBatterySleepPushMethod('webhook', false)).toBe('webhook')
  })
})

describe('shouldAcceptSleepPushSource (lib)', () => {
  it('always accepts native baichuan / omitted source', () => {
    expect(shouldAcceptSleepPushSource(undefined, 'webhook', true)).toBe(true)
    expect(shouldAcceptSleepPushSource('baichuan', 'email', false)).toBe(true)
  })

  it('auto + supported keeps webhook and drops email', () => {
    expect(shouldAcceptSleepPushSource('baichuanWebhook', 'auto', true)).toBe(true)
    expect(shouldAcceptSleepPushSource('email', 'auto', true)).toBe(false)
  })

  it('auto + unsupported keeps email and drops webhook', () => {
    expect(shouldAcceptSleepPushSource('email', 'auto', false)).toBe(true)
    expect(shouldAcceptSleepPushSource('baichuanWebhook', 'auto', false)).toBe(false)
  })
})
