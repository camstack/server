/**
 * Unit tests for the WhatsApp / Green API notifier adapter. Pure — no network
 * for buildRequest; probe resolution helpers are pure too.
 */
import { type Notification, prepareNotification } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { HttpRequestPlan } from '../../adapters/adapter.js'
import {
  GREEN_API_UNIVERSAL_URL,
  greenApiHostModeOf,
  parseGreenApiContactRows,
  resolveGreenApiUrl,
  resolveGreenMediaUrl,
  whatsappAdapter,
} from '../../adapters/whatsapp.js'

const CAPS = whatsappAdapter.descriptor.caps

function planFor(config: Record<string, unknown>, notification: Notification): HttpRequestPlan {
  const prepared = prepareNotification(CAPS, notification)
  return whatsappAdapter.buildRequest(config, prepared)
}

function jsonValue(plan: HttpRequestPlan): Record<string, unknown> {
  expect(plan.body?.kind).toBe('json')
  if (plan.body?.kind !== 'json') throw new Error('expected json body')
  return plan.body.value as Record<string, unknown>
}

const GREEN_CONFIG = {
  apiHostMode: 'custom',
  apiUrl: 'https://api.greenapi.com',
  idInstance: '1101',
  apiTokenInstance: 'tok',
  chatId: '39333',
  acknowledgeToS: true,
}

const PLAIN: Notification = { body: 'Hello', format: 'text', priority: 3 }
const WITH_IMAGE: Notification = {
  body: 'Look',
  format: 'text',
  priority: 3,
  attachments: [{ mediaType: 'image', url: 'https://ex.com/a/snap.jpg', mime: 'image/png' }],
}
const WITH_TITLE: Notification = { body: 'Body', title: 'Alert', format: 'text', priority: 3 }

describe('whatsapp adapter — green-api send', () => {
  it('plain text → sendMessage', () => {
    const plan = planFor(GREEN_CONFIG, PLAIN)
    expect(plan.url).toBe('https://api.greenapi.com/waInstance1101/sendMessage/tok')
    expect(plan.method).toBe('POST')
    expect(plan.headers).toBeUndefined()
    expect(jsonValue(plan)).toEqual({ chatId: '39333@c.us', message: 'Hello' })
  })

  it('with image → sendFileByUrl', () => {
    const plan = planFor(GREEN_CONFIG, WITH_IMAGE)
    expect(plan.url).toBe('https://api.greenapi.com/waInstance1101/sendFileByUrl/tok')
    expect(jsonValue(plan)).toEqual({
      chatId: '39333@c.us',
      urlFile: 'https://ex.com/a/snap.jpg',
      fileName: 'snap.jpg',
      caption: 'Look',
    })
  })

  it('title → bold first line', () => {
    const plan = planFor(GREEN_CONFIG, WITH_TITLE)
    expect(jsonValue(plan).message).toBe('*Alert*\nBody')
  })
})

describe('whatsapp adapter — host resolution', () => {
  it('defaults to universal', () => {
    expect(resolveGreenApiUrl({ idInstance: '7103955195' })).toBe(GREEN_API_UNIVERSAL_URL)
    expect(greenApiHostModeOf({})).toBe('universal')
  })

  it('auto derives partition from idInstance', () => {
    expect(resolveGreenApiUrl({ apiHostMode: 'auto', idInstance: '7103123456' })).toBe(
      'https://7103.api.greenapi.com',
    )
  })

  it('7103 and 7105 cluster hosts', () => {
    expect(resolveGreenApiUrl({ apiHostMode: '7103', idInstance: 'x' })).toBe(
      'https://7103.api.greenapi.com',
    )
    expect(resolveGreenApiUrl({ apiHostMode: '7105', idInstance: 'x' })).toBe(
      'https://7105.api.greenapi.com',
    )
  })

  it('custom requires apiUrl', () => {
    expect(resolveGreenApiUrl({ apiHostMode: 'custom', apiUrl: 'https://h.example/' })).toBe(
      'https://h.example',
    )
    expect(() => resolveGreenApiUrl({ apiHostMode: 'custom' })).toThrow(/apiUrl/)
  })

  it('legacy apiUrl without mode falls back to universal (apiUrl is unused)', () => {
    expect(greenApiHostModeOf({ apiUrl: 'https://legacy.example' })).toBe('universal')
    expect(resolveGreenApiUrl({ apiUrl: 'https://legacy.example', idInstance: '1' })).toBe(
      GREEN_API_UNIVERSAL_URL,
    )
  })

  it('mirrors media host for non-custom modes', () => {
    expect(resolveGreenMediaUrl({ apiHostMode: 'universal' })).toBe('https://media.greenapi.com')
    expect(resolveGreenMediaUrl({ apiHostMode: '7105' })).toBe('https://7105.media.greenapi.com')
    expect(resolveGreenMediaUrl({ apiHostMode: 'auto', idInstance: '7103123456' })).toBe(
      'https://7103.media.greenapi.com',
    )
  })

  it('buildRequest uses universal by default', () => {
    const plan = planFor(
      {
        idInstance: '7103955195',
        apiTokenInstance: 'tok',
        chatId: '39333',
        acknowledgeToS: true,
      },
      PLAIN,
    )
    expect(plan.url).toBe('https://api.greenapi.com/waInstance7103955195/sendMessage/tok')
  })

  it('auto throws when idInstance has no digit prefix', () => {
    expect(() => resolveGreenApiUrl({ apiHostMode: 'auto', idInstance: 'abc' })).toThrow(/auto/)
  })
})

describe('whatsapp adapter — guards', () => {
  it('refuses to build until the ToS is acknowledged', () => {
    const prepared = prepareNotification(CAPS, PLAIN)
    expect(() =>
      whatsappAdapter.buildRequest({ ...GREEN_CONFIG, acknowledgeToS: false }, prepared),
    ).toThrow(/acknowledgeToS/)
  })

  it('appends the clickUrl on its own line for a link preview', () => {
    const plan = planFor(GREEN_CONFIG, { ...PLAIN, clickUrl: 'https://cam.local/e/1' })
    expect(jsonValue(plan).message).toBe('Hello\nhttps://cam.local/e/1')
  })

  it('descriptor is Green API only with contact discovery', () => {
    expect(whatsappAdapter.descriptor.kind).toBe('whatsapp')
    expect(whatsappAdapter.descriptor.label).toBe('WhatsApp / Green API')
    expect(whatsappAdapter.descriptor.supportsDiscovery).toBe(true)
    expect(typeof whatsappAdapter.discover).toBe('function')
    expect(CAPS.levels).toEqual([{ id: 'normal', label: 'Normal', ordinal: 3 }])
  })

  it('parseGreenApiContactRows maps id/name and dedupes', () => {
    const rows = parseGreenApiContactRows([
      { id: '39333@c.us', name: 'Alice' },
      { id: '39333@c.us', name: 'Alice dup' },
      { id: '120363@g.us', contactName: 'Family' },
      { id: '', name: 'skip' },
      { noId: true },
    ])
    expect(rows).toEqual([
      { kind: 'whatsapp', suggestedName: 'Alice', config: { chatId: '39333@c.us' } },
      { kind: 'whatsapp', suggestedName: 'Family', config: { chatId: '120363@g.us' } },
    ])
  })

  it('schema has apiHostMode default universal and no backend field', () => {
    const fields = whatsappAdapter.descriptor.configSchema.sections[0]?.fields ?? []
    const byKey = new Map(fields.map((f) => [f.key, f]))
    expect(byKey.has('backend')).toBe(false)
    expect(byKey.has('baseUrl')).toBe(false)
    const host = byKey.get('apiHostMode')
    expect(host && 'default' in host ? host.default : undefined).toBe('universal')
    const apiUrl = byKey.get('apiUrl')
    expect(apiUrl && 'showWhen' in apiUrl ? apiUrl.showWhen : undefined).toEqual({
      field: 'apiHostMode',
      equals: 'custom',
    })
  })

  it('exposes probe', () => {
    expect(typeof whatsappAdapter.probe).toBe('function')
  })
})
