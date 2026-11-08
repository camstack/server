import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { COMMAND_ARGS_MAX_BYTES, createCommandArgsPreparer } from '../command-args.js'

const secret = z.string().meta({ secret: true })

describe('command args preparer (D1022)', () => {
  const inputs = new Map<string, z.ZodType>([
    ['lock|unlockWith', z.object({ deviceId: z.number(), code: secret, note: z.string() })],
    ['switch|setState', z.object({ deviceId: z.number(), on: z.boolean() })],
  ])
  const prepare = createCommandArgsPreparer((cap, method) => inputs.get(`${cap}|${method}`))

  it('drops the routing keys and keeps the rest', () => {
    expect(prepare('switch', 'setState', { deviceId: 7, nodeId: 'hub', caller: 'x', on: true })).toEqual({
      on: true,
    })
  })

  it('replaces a value the schema declares secret', () => {
    const out = prepare('lock', 'unlockWith', { deviceId: 7, code: '123456', note: 'front door' })
    expect(out).toEqual({ code: '[redacted]', note: 'front door' })
    expect(JSON.stringify(out)).not.toContain('123456')
  })

  it('redacts everything when the method has no known schema but a key names a credential', () => {
    expect(prepare('unknown', 'x', { deviceId: 7, password: 'hunter2', a: 1 })).toEqual({
      password: '[redacted]',
      a: 1,
    })
  })

  it('replaces an oversized argument bag with a marker, not a prefix', () => {
    const out = prepare('switch', 'setState', { deviceId: 7, blob: 'x'.repeat(COMMAND_ARGS_MAX_BYTES * 2) })
    expect(out).toEqual({ _truncated: true })
  })
})
