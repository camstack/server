import { describe, expect, it } from 'vitest'
import { shouldAcceptSleepPushSource } from '@apocaliss92/nodelink-js'
import {
  buildBaichuanWebhookUrl,
  resolveBatterySleepPushMethod,
} from '../baichuan-webhook-shared.js'

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

describe('buildBaichuanWebhookUrl', () => {
  it('builds a plain HTTP LAN URL with encoded camera id', () => {
    expect(
      buildBaichuanWebhookUrl({
        host: '192.168.10.9',
        port: 9081,
        cameraId: 'cam/abc',
      }),
    ).toBe('http://192.168.10.9:9081/webhook/cam%2Fabc')
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
