import { describe, expect, it } from 'vitest'
import {
  EMPTY_REMOTE_CONFIG,
  readStoredRemoteConfig,
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

  it('refuses an id that is another channel number, but not a source its own number', () => {
    const five: RemoteSource = { kind: 'digits', id: 'five', name: 'Cinque', number: '5' }
    expect(parse([five, { ...HDMI, id: '5' }]).success).toBe(false)
    expect(parse([{ ...five, id: '5' }]).success).toBe(true)
  })

  it('a digits source may be named by its own number', () => {
    const own: RemoteSource = { kind: 'digits', id: 'five', name: '5', number: '5' }
    expect(parse([own]).success).toBe(true)
    expect(resolveRemoteSource([own], '5')).toBe(own)
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

describe('an infrared source (planning#464)', () => {
  const IR: RemoteSource = {
    kind: 'ir',
    id: 'hdmi2',
    name: 'HDMI 2',
    transmitterId: 3,
    payload: { kind: 'raw', timings: [9000, -4500, 560, -560], settings: { carrierHz: 38000 } },
  }

  it('is accepted with a raw train and with a Pronto code, and presses no role', () => {
    expect(parse([IR]).success).toBe(true)
    expect(remoteSourceSteps(IR)).toEqual([])
    const pronto: RemoteSource = {
      ...IR,
      id: 'p',
      name: 'Pronto',
      payload: { kind: 'pronto', code: '0000 006D 0001 0000 00AC 00AC' },
    }
    expect(parse([pronto]).success).toBe(true)
  })

  it('refuses a code the transmitter could not send, on the payload field', () => {
    const bad: RemoteSource = { ...IR, payload: { kind: 'raw', timings: [9000, 4500] } }
    const parsed = parse([bad])
    expect(parsed.success).toBe(false)
    const issue = parsed.error?.issues.find((i) => i.path.join('.') === 'sources.0.payload')
    expect(issue?.message).toMatch(/space/)
  })

  it('resolves by name and by id, and is never a channel', () => {
    expect(resolveRemoteSource([RAI1, IR], 'hdmi 2')).toBe(IR)
    expect(resolveRemoteSource([RAI1, IR], 'hdmi2')).toBe(IR)
    expect(findChannelSource([RAI1, IR], '1')).toBe(RAI1)
  })
})

describe('reading a stored remote with a bad source (planning#464)', () => {
  const good: RemoteSource = { kind: 'sequence', id: 'hdmi1', name: 'HDMI 1', steps: ['ok'] }
  const badIr = {
    kind: 'ir',
    id: 'hdmi2',
    name: 'HDMI 2',
    transmitterId: 3,
    payload: { kind: 'raw', timings: [9000, 4500] },
  }
  const stored = {
    ...EMPTY_REMOTE_CONFIG,
    layoutTemplateId: 'tpl',
    bindings: { ok: binding },
    sources: [good, badIr],
  }

  it('the write schema still refuses it', () => {
    expect(RemoteConfigSchema.safeParse(stored).success).toBe(false)
  })

  it('a read leaves the bad source out with its reason; the rest still loads', () => {
    const read = readStoredRemoteConfig(stored)
    expect(read.success).toBe(true)
    if (!read.success) return
    expect(read.data.sources).toEqual([good])
    expect(read.data.layoutTemplateId).toBe('tpl')
    expect(Object.keys(read.data.bindings)).toEqual(['ok'])
    expect(read.data.refusedSources).toHaveLength(1)
    expect(read.data.refusedSources?.[0]).toMatchObject({ index: 1, id: 'hdmi2', name: 'HDMI 2' })
    expect(read.data.refusedSources?.[0]?.reason).toMatch(/space/)
  })

  it('a source that is not even an object shape is refused by name of its problem', () => {
    const read = readStoredRemoteConfig({ ...stored, sources: [good, { kind: 'ir' }] })
    expect(read.success).toBe(true)
    if (read.success) expect(read.data.refusedSources?.[0]?.id).toBeNull()
  })

  it('a clean config carries no refused sources', () => {
    const read = readStoredRemoteConfig({ ...stored, sources: [good] })
    expect(read.success && read.data.refusedSources).toBeFalsy()
  })

  it('another defect still fails the whole read', () => {
    expect(readStoredRemoteConfig({ ...stored, bindings: 3 }).success).toBe(false)
  })
})
