/**
 * Table-driven unit tests for the pushover adapter's PURE `buildRequest`.
 *
 * Each case feeds a canonical `Notification` through the real degrade engine
 * (`prepareNotification` with the adapter's own caps) so level resolution +
 * format transcode match production, then asserts the exact multipart request
 * the adapter emits. NO network — `discover` is exercised structurally only
 * (missing-credential short-circuit), never dialing Pushover.
 */
import { type Notification, prepareNotification } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { HttpRequestPlan, MultipartPart, TargetConfig } from '../../adapters/adapter.js'
import { pushoverAdapter } from '../../adapters/pushover.js'

const CAPS = pushoverAdapter.descriptor.caps

const BASE_CONFIG: TargetConfig = {
  appToken: 'app-token-xyz',
  userOrGroupKey: 'user-key-abc',
}

function prepare(notification: Partial<Notification> & { body: string }) {
  // `prepareNotification` applies the schema defaults (format:'text', priority:3).
  return prepareNotification(CAPS, {
    format: 'text',
    priority: 3,
    ...notification,
  } as Notification)
}

function multipartParts(plan: HttpRequestPlan): readonly MultipartPart[] {
  expect(plan.body?.kind).toBe('multipart')
  if (plan.body?.kind !== 'multipart') throw new Error('expected multipart body')
  return plan.body.parts
}

/** Reduce the field parts to a `name → value` map for concise assertions. */
function fields(plan: HttpRequestPlan): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of multipartParts(plan)) {
    if (part.kind === 'field') out[part.name] = part.value
  }
  return out
}

function filePart(plan: HttpRequestPlan): Extract<MultipartPart, { kind: 'file' }> | undefined {
  return multipartParts(plan).find(
    (p): p is Extract<MultipartPart, { kind: 'file' }> => p.kind === 'file',
  )
}

describe('pushoverAdapter.descriptor', () => {
  it('declares the capability profile from the matrix', () => {
    const d = pushoverAdapter.descriptor
    expect(d.kind).toBe('pushover')
    expect(d.supportsDiscovery).toBe(true)
    expect(d.caps.attachments).toEqual({
      mediaTypes: ['image'],
      mode: 'bytes',
      max: 1,
      maxBytes: 5_242_880,
    })
    expect(d.caps.actions).toBe(0)
    expect(d.caps.format).toEqual(['text', 'html'])
    expect(d.caps.bodyMaxLen).toBe(1024)
    expect(d.caps.clickUrl).toBe(true)
    expect(d.caps.sound).toBe(true)
    expect(d.caps.ttl).toBe(true)
    const emergency = d.caps.levels.find((l) => l.id === 'emergency')
    expect(emergency?.ordinal).toBe(5)
    expect(emergency?.flags?.critical).toBe(true)
    expect(emergency?.requires).toEqual(['retry', 'expire'])
  })
})

describe('pushoverAdapter.buildRequest — endpoint', () => {
  it('POSTs multipart to the messages endpoint', () => {
    const plan = pushoverAdapter.buildRequest(BASE_CONFIG, prepare({ body: 'hi' }))
    expect(plan.url).toBe('https://api.pushover.net/1/messages.json')
    expect(plan.method).toBe('POST')
    expect(plan.body?.kind).toBe('multipart')
  })
})

describe('pushoverAdapter.buildRequest — field mapping', () => {
  interface Case {
    readonly name: string
    readonly config: TargetConfig
    readonly notification: Partial<Notification> & { body: string }
    readonly expectFields: Record<string, string>
    readonly absentFields?: readonly string[]
  }

  const cases: readonly Case[] = [
    {
      name: 'plain text, normal priority',
      config: BASE_CONFIG,
      notification: { body: 'Motion detected', title: 'Front door' },
      expectFields: {
        token: 'app-token-xyz',
        user: 'user-key-abc',
        message: 'Motion detected',
        title: 'Front door',
        priority: '0',
      },
      absentFields: ['html', 'url', 'retry', 'expire', 'ttl', 'device', 'sound'],
    },
    {
      name: 'html format sets html=1',
      config: BASE_CONFIG,
      notification: { body: '<b>Alert</b>', format: 'html' },
      expectFields: { message: '<b>Alert</b>', html: '1' },
    },
    {
      name: 'priority ordinal 1 → native -2 (lowest)',
      config: BASE_CONFIG,
      notification: { body: 'quiet', priority: 1 },
      expectFields: { priority: '-2' },
      absentFields: ['retry', 'expire'],
    },
    {
      name: 'priority ordinal 3 → native 0 (normal)',
      config: BASE_CONFIG,
      notification: { body: 'normal', priority: 3 },
      expectFields: { priority: '0' },
    },
    {
      name: 'priority ordinal 5 → native 2 (emergency) with retry/expire from config',
      config: { ...BASE_CONFIG, retry: 120, expire: 7200 },
      notification: { body: 'EMERGENCY', priority: 5 },
      expectFields: { priority: '2', retry: '120', expire: '7200' },
    },
    {
      name: 'emergency without config retry/expire uses defaults',
      config: BASE_CONFIG,
      notification: { body: 'EMERGENCY', priority: 5 },
      expectFields: { priority: '2', retry: '60', expire: '3600' },
    },
    {
      name: 'clickUrl maps to url + url_title (from title)',
      config: BASE_CONFIG,
      notification: { body: 'tap me', title: 'Camera', clickUrl: 'https://cam.local/live' },
      expectFields: { url: 'https://cam.local/live', url_title: 'Camera' },
    },
    {
      name: 'sound + device from config, ttl passed through',
      config: { ...BASE_CONFIG, device: 'phone-1', defaultSound: 'siren' },
      notification: { body: 'ping', ttl: 300 },
      expectFields: { device: 'phone-1', sound: 'siren', ttl: '300' },
    },
    {
      name: 'notification sound overrides the target default',
      config: { ...BASE_CONFIG, defaultSound: 'siren' },
      notification: { body: 'ping', sound: 'cosmic' },
      expectFields: { sound: 'cosmic' },
    },
    {
      name: 'ttl suppressed at emergency priority',
      config: BASE_CONFIG,
      notification: { body: 'urgent', priority: 5, ttl: 300 },
      expectFields: { priority: '2' },
      absentFields: ['ttl'],
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      const plan = pushoverAdapter.buildRequest(testCase.config, prepare(testCase.notification))
      const f = fields(plan)
      for (const [key, value] of Object.entries(testCase.expectFields)) {
        expect(f[key], `field ${key}`).toBe(value)
      }
      for (const key of testCase.absentFields ?? []) {
        expect(f[key], `field ${key} should be absent`).toBeUndefined()
      }
    })
  }
})

describe('pushoverAdapter.buildRequest — image attachment', () => {
  it('emits an `attachment` file part for a bytes image', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const plan = pushoverAdapter.buildRequest(
      BASE_CONFIG,
      prepare({
        body: 'snapshot',
        attachments: [{ mediaType: 'image', bytes, mime: 'image/png', name: 'shot.png' }],
      }),
    )
    const file = filePart(plan)
    expect(file).toBeDefined()
    expect(file?.name).toBe('attachment')
    expect(file?.bytes).toEqual(bytes)
    expect(file?.contentType).toBe('image/png')
    expect(file?.filename).toBe('shot.png')
  })

  it('uses default filename + content-type when the attachment omits them', () => {
    const plan = pushoverAdapter.buildRequest(
      BASE_CONFIG,
      prepare({ body: 'snap', attachments: [{ mediaType: 'image', bytes: new Uint8Array([9]) }] }),
    )
    const file = filePart(plan)
    expect(file?.filename).toBe('attachment.jpg')
    expect(file?.contentType).toBe('image/jpeg')
  })

  it('drops a non-image attachment (capability-gated by the degrade engine)', () => {
    const plan = pushoverAdapter.buildRequest(
      BASE_CONFIG,
      prepare({ body: 'clip', attachments: [{ mediaType: 'video', url: 'https://x/clip.mp4' }] }),
    )
    expect(filePart(plan)).toBeUndefined()
  })
})

describe('pushoverAdapter.discover', () => {
  it('returns [] when credentials are missing (no network)', async () => {
    await expect(pushoverAdapter.discover?.({})).resolves.toEqual([])
    await expect(pushoverAdapter.discover?.({ appToken: 'only-token' })).resolves.toEqual([])
  })
})
