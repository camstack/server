import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { COMMAND_ARGS_MAX_BYTES, createCommandArgsPreparer } from '../command-args.js'

const secret = z.string().meta({ secret: true })

describe('command args preparer (D1022)', () => {
  const inputs = new Map<string, z.ZodType>([
    ['lock|unlockWith', z.object({ deviceId: z.number(), code: secret, note: z.string() })],
    [
      'hub|configure',
      z.object({
        deviceId: z.number(),
        auth: secret.optional(),
        rows: z.array(z.object({ name: z.string(), token: secret })),
        creds: z.record(z.string(), secret),
        blob: z.object({ a: z.string() }).meta({ secret: true }),
      }),
    ],
    ['switch|setState', z.object({ deviceId: z.number(), on: z.boolean() })],
  ])
  const prepare = createCommandArgsPreparer((cap, method) => inputs.get(`${cap}|${method}`))

  it('drops the routing keys and keeps the rest', () => {
    expect(
      prepare('switch', 'setState', { deviceId: 7, nodeId: 'hub', caller: 'x', on: true }),
    ).toEqual({
      on: true,
    })
  })

  it('replaces a value the schema declares secret', () => {
    const out = prepare('lock', 'unlockWith', { deviceId: 7, code: '123456', note: 'front door' })
    expect(out).toEqual({ code: '***', note: 'front door' })
    expect(JSON.stringify(out)).not.toContain('123456')
  })

  it('redacts everything when the method has no known schema but a key names a credential', () => {
    expect(prepare('unknown', 'x', { deviceId: 7, password: 'hunter2', a: 1 })).toEqual({
      password: '***',
      a: 1,
    })
  })

  it('replaces an oversized argument bag with a marker, not a prefix', () => {
    const out = prepare('switch', 'setState', {
      deviceId: 7,
      blob: 'x'.repeat(COMMAND_ARGS_MAX_BYTES * 2),
    })
    expect(out).toEqual({ _truncated: true })
  })

  it('redacts a nested value under a credential-named key', () => {
    const out = prepare('switch', 'setState', { deviceId: 7, options: { token: 'abc', fine: 1 } })
    expect(out).toEqual({ options: { token: '***', fine: 1 } })
  })

  it('redacts a pin, an otp and a code of any type, at any depth', () => {
    const out = prepare('lock', 'x', {
      pin: 1234,
      otp: '998877',
      nested: [{ code: 5 }],
      note: 'ok',
    })
    expect(JSON.stringify(out)).not.toMatch(/1234|998877|:5/)
    expect(out).toMatchObject({ note: 'ok' })
  })

  it('keeps keyFrame-style words that merely contain key or code', () => {
    const out = prepare('camera', 'x', {
      keyFrame: true,
      encoder: 'h264',
      mapping: 'a',
      statusText: 'b',
    })
    expect(out).toEqual({ keyFrame: true, encoder: 'h264', mapping: 'a', statusText: 'b' })
  })

  it('applies secret paths with their nesting: arrays, maps and an object declared secret', () => {
    const out = prepare('hub', 'configure', {
      deviceId: 7,
      rows: [
        { name: 'a', token: 'T1' },
        { name: 'b', token: 'T2' },
      ],
      creds: { one: 'S1', two: 'S2' },
      blob: { a: 'whole' },
    })
    expect(out).toEqual({
      rows: [
        { name: 'a', token: '***' },
        { name: 'b', token: '***' },
      ],
      creds: { one: '***', two: '***' },
      blob: '***',
    })
  })

  it('masks a URL credential inside a free-text argument', () => {
    const out = prepare('switch', 'x', { url: 'rtsp://admin:hunter22@10.0.0.5/live' })
    expect(JSON.stringify(out)).not.toContain('hunter22')
  })
})
