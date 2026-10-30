import { describe, expect, it } from 'vitest'
import {
  buildRawState,
  collectRedactedSnapshot,
  type RawStateReader,
  type RuntimeStateSnapshot,
  redactSecrets,
} from '../raw-state'

/**
 * Minimal fake of the runtime-state surface used by the raw-state
 * helper. Only `snapshot()` is consumed — we feed it a frozen
 * cap-keyed record exactly as `DeviceRuntimeState.snapshot()` returns.
 */
function fakeRuntimeState(slices: Record<string, Record<string, unknown>>): RawStateReader {
  const frozen: Record<string, Record<string, unknown>> = {}
  for (const [k, v] of Object.entries(slices)) frozen[k] = Object.freeze({ ...v })
  const snap = Object.freeze(frozen) as RuntimeStateSnapshot
  return { snapshot: () => snap }
}

describe('redactSecrets', () => {
  it('removes credential-bearing keys at any depth', () => {
    const out = redactSecrets({
      percent: 42,
      password: 'hunter2',
      nested: { token: 'abc', ok: 1, deeper: { secret: 'x', kept: true } },
      list: [{ authHeader: 'Bearer y', value: 5 }],
    })
    expect(JSON.stringify(out)).not.toMatch(/password|token|secret|auth/i)
    expect(out).toMatchObject({
      percent: 42,
      nested: { ok: 1, deeper: { kept: true } },
      list: [{ value: 5 }],
    })
  })

  it('does not mutate the input object', () => {
    const input = { password: 'x', percent: 1 }
    redactSecrets(input)
    expect(input.password).toBe('x')
  })
})

describe('collectRedactedSnapshot', () => {
  it('returns all written cap slices, redacted', () => {
    const rs = fakeRuntimeState({
      ptz: { pan: 10, credential: 'leak' },
      motion: { active: true },
    })
    const data = collectRedactedSnapshot(rs)
    expect(data).toMatchObject({ ptz: { pan: 10 }, motion: { active: true } })
    expect(JSON.stringify(data)).not.toMatch(/credential/i)
  })

  it('returns an empty object when there are no slices', () => {
    expect(collectRedactedSnapshot(fakeRuntimeState({}))).toEqual({})
  })
})

describe('buildRawState', () => {
  it('returns {source:"hikvision", data:<cached runtimeState slices>}', () => {
    const rs = fakeRuntimeState({ ptz: { pan: 10 } })
    const raw = buildRawState(rs)
    expect(raw?.source).toBe('hikvision')
    expect(raw?.data).toMatchObject({ ptz: { pan: 10 } })
  })

  it('returns null when there is no cached state', () => {
    expect(buildRawState(fakeRuntimeState({}))).toBeNull()
  })

  it('omits credential-bearing fields', () => {
    const rs = fakeRuntimeState({ ptz: { pan: 10, password: 'hunter2', token: 'abc' } })
    const raw = buildRawState(rs)
    expect(JSON.stringify(raw)).not.toMatch(/password|token|secret/i)
  })
})
