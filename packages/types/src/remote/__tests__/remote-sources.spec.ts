import { describe, expect, it } from 'vitest'
import {
  EMPTY_REMOTE_CONFIG,
  RemoteConfigSchema,
  RemoteAssumedStateSchema,
} from '../remote-config.js'
import {
  findChannelSource,
  type RemoteSource,
  remoteSourceSteps,
  resolveRemoteSource,
} from '../remote-sources.js'

const action = {
  kind: 'cap' as const,
  deviceId: 3,
  cap: 'ir-transmitter',
  method: 'send',
}
const binding = { action }
const digits = Object.fromEntries(Array.from({ length: 10 }, (_, d) => [`digit_${d}`, binding]))

const RAI1: RemoteSource = {
  kind: 'digits',
  id: 'rai1',
  name: 'Rai 1',
  number: '1',
}
const C24: RemoteSource = {
  kind: 'digits',
  id: 'c24',
  name: 'Canale 24',
  number: '25',
}
const HDMI: RemoteSource = {
  kind: 'sequence',
  id: 'hdmi1',
  name: 'HDMI 1',
  steps: ['input', 'down', 'ok'],
}

function parse(sources: readonly unknown[], unbound?: string) {
  const bindings: Record<string, unknown> = {
    ...digits,
    input: binding,
    down: binding,
    ok: binding,
  }
  if (unbound !== undefined) delete bindings[unbound]
  return RemoteConfigSchema.safeParse({
    ...EMPTY_REMOTE_CONFIG,
    bindings,
    sources,
  })
}

describe('declared sources', () => {
  it('a remote that declares none has none, and the stored configs of before still parse', () => {
    const { sources: _s, stepDelayMs: _d, ...stored } = EMPTY_REMOTE_CONFIG
    const parsed = RemoteConfigSchema.safeParse(stored)
    expect(parsed.success && parsed.data.sources).toEqual([])
    expect(parsed.success && parsed.data.stepDelayMs).toBe(500)
  })

  it('accepts a digits and a sequence source whose steps are bound', () => {
    expect(parse([RAI1, C24, HDMI]).success).toBe(true)
  })

  it('derives the steps of a digits source from its number', () => {
    expect(remoteSourceSteps(C24)).toEqual(['digit_2', 'digit_5'])
    expect(remoteSourceSteps(HDMI)).toEqual(['input', 'down', 'ok'])
  })

  it('refuses a step that is not bound, for a sequence and for a number', () => {
    expect(parse([HDMI]).success).toBe(true)
    expect(parse([HDMI], 'ok').success).toBe(false)
    expect(parse([C24]).success).toBe(true)
    expect(parse([C24], 'digit_5').success).toBe(false)
  })

  it('refuses a repeated id, a repeated name and a repeated channel number', () => {
    expect(parse([RAI1, { ...C24, id: 'rai1' }]).success).toBe(false)
    expect(parse([RAI1, { ...C24, name: 'rai 1' }]).success).toBe(false)
    expect(parse([RAI1, { ...C24, number: '1' }]).success).toBe(false)
  })

  it('refuses a name that is another channel number: the name and the number must reach one source', () => {
    expect(parse([RAI1, { ...HDMI, name: '1' }]).success).toBe(false)
  })

  it('bounds stepDelayMs to 100..3000', () => {
    const ok = (stepDelayMs: number) =>
      RemoteConfigSchema.safeParse({ ...EMPTY_REMOTE_CONFIG, stepDelayMs }).success
    expect(ok(100) && ok(3000)).toBe(true)
    expect(ok(99) || ok(3001)).toBe(false)
  })

  it('resolves a source by name, by id and by channel number to the same declared source', () => {
    const all = [RAI1, C24, HDMI]
    expect(resolveRemoteSource(all, 'rai 1')).toBe(RAI1)
    expect(resolveRemoteSource(all, 'rai1')).toBe(RAI1)
    expect(resolveRemoteSource(all, '1')).toBe(RAI1)
    expect(resolveRemoteSource(all, '25')).toBe(C24)
    expect(resolveRemoteSource(all, '7')).toBeNull()
    expect(findChannelSource(all, '2')).toBeNull()
  })

  it('a stored assumed state without a source parses with none', () => {
    const parsed = RemoteAssumedStateSchema.safeParse({
      power: null,
      muted: null,
    })
    expect(parsed.success && parsed.data.source).toBeNull()
  })
})
