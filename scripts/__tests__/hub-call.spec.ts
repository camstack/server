import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../../packages/types/src/generated/capability-router-map.js'
import { hubInvocation } from '../hub/hub-call.js'

describe('hubInvocation', () => {
  it('hub.mjs gets NO input for an undefined input, and the JSON on stdin - never argv - otherwise', () => {
    expect(hubInvocation([], 'GET', 'addons.list', undefined)).toEqual({
      args: ['GET', 'addons.list'],
      stdin: undefined,
    })
    const big = { records: Array.from({ length: 2000 }, (_, n) => ({ n })) }
    const call = hubInvocation(['--server', 'h'], 'POST', 'settingsStore.transact', big)
    expect(call.args).toEqual(['--server', 'h', 'POST', 'settingsStore.transact', '-'])
    expect(call.stdin).toBe(JSON.stringify(big))
  })

  it('DISARM: an explicit null is exactly what the real schema rejects', () => {
    const cap = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === 'addons')
    expect(cap?.methods['list']?.input.safeParse(null).success).toBe(false)
    expect(cap?.methods['list']?.input.safeParse(undefined).success).toBe(true)
  })
})
