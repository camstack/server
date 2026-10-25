import type { ClaimOutcome } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TargetAsyncFailure } from '../composition-runtime.js'
import { type OwnedFieldsApi, OwnedFieldsTarget } from '../owned-fields-target.js'
import { type RecordingLogger, recordingLogger } from './fixtures.js'

const FIELDS = ['percentage', 'charging', 'sleeping', 'lastUpdated']
const SEED = { percentage: 15, charging: 'unknown', sleeping: false, lastUpdated: 1_000 }
const OK: ClaimOutcome = { ok: true, changed: true }

let log: RecordingLogger

beforeEach(() => {
  log = recordingLogger()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function api(overrides: Partial<OwnedFieldsApi>): OwnedFieldsApi {
  return {
    claimFields: vi.fn(async () => OK),
    patchOwnedFields: vi.fn(async () => OK),
    releaseClaim: vi.fn(async () => OK),
    ...overrides,
  }
}

function target(a: OwnedFieldsApi, fields: readonly string[] = FIELDS): OwnedFieldsTarget {
  return new OwnedFieldsTarget({
    deviceId: 50,
    owner: 'blk-1',
    modeOf: () => 'add',
    fieldsOf: () => fields,
    api: a,
    logger: log.logger,
  })
}

/** The chain has no timers: two macrotask turns drain it. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

describe('claim events the tracker follows (C-1, N-1, N-3, N-7)', () => {
  function replaceTarget(a: OwnedFieldsApi, events: string[]): OwnedFieldsTarget {
    return new OwnedFieldsTarget({
      deviceId: 51,
      owner: 'blk-1',
      modeOf: (cap) => (cap === 'binary' ? 'replace' : 'add'),
      fieldsOf: () => ['on'],
      api: a,
      logger: log.logger,
      onClaim: (cap, event) => events.push(`${cap}:${event}`),
    })
  }

  it('a replace claim reports claiming, then held; a confirmed release reports free', async () => {
    const events: string[] = []
    const t = replaceTarget(api({}), events)
    t.seed('binary', { on: true })
    await settle()
    t.withhold('binary', ['on'])
    await settle()
    expect(events).toEqual(['binary:claiming', 'binary:held', 'binary:free'])
  })

  it('a claim that throws is `unsettled` — it changes nothing (D49)', async () => {
    const events: string[] = []
    const t = replaceTarget(
      api({ claimFields: vi.fn(async () => Promise.reject(new Error('down'))) }),
      events,
    )
    t.seed('binary', { on: true })
    await settle()
    expect(events).toEqual(['binary:claiming', 'binary:unsettled'])
  })

  it('N-3: `field-not-claimed` on a patch does NOT free the cap — the hub still holds a claim; only `not-claimed` does', async () => {
    const events: string[] = []
    const patchOwnedFields = vi
      .fn<OwnedFieldsApi['patchOwnedFields']>()
      .mockResolvedValueOnce({ ok: false, code: 'field-not-claimed', message: 'x' })
      .mockResolvedValueOnce({ ok: false, code: 'not-claimed', message: 'y' })
    const t = replaceTarget(api({ patchOwnedFields }), events)
    t.seed('binary', { on: true })
    await settle()
    t.patch('binary', { on: false })
    await settle()
    expect(events).toEqual(['binary:claiming', 'binary:held'])
    // The next write re-claims (landed dropped); make it land, then a patch answers not-claimed.
    t.patch('binary', { on: true })
    await settle()
    t.patch('binary', { on: false })
    await settle()
    expect(events.at(-1)).toBe('binary:free')
  })

  it('N-7: an `add` cap reports nothing — it has no native the tracker must tell apart', async () => {
    const events: string[] = []
    const t = replaceTarget(api({}), events)
    t.seed('battery', { on: 1 })
    await settle()
    expect(events).toEqual([])
  })
})

describe('OwnedFieldsTarget — the claim-backed write target (D663, S5)', () => {
  it('the first write is a CLAIM with the full planned field set; the next is a patch', async () => {
    const claimFields = vi.fn(async () => OK)
    const patchOwnedFields = vi.fn(async () => OK)
    const t = target(api({ claimFields, patchOwnedFields }))
    expect(t.seed('battery', SEED)).toEqual({ ok: true })
    await settle()
    expect(t.patch('battery', { percentage: 100 })).toEqual({ ok: true })
    await settle()
    expect(claimFields).toHaveBeenCalledWith({
      deviceId: 50,
      capName: 'battery',
      owner: 'blk-1',
      mode: 'add',
      fields: FIELDS,
      values: SEED,
    })
    expect(patchOwnedFields).toHaveBeenCalledWith({
      deviceId: 50,
      capName: 'battery',
      owner: 'blk-1',
      values: { percentage: 100 },
    })
  })

  it('a claim carries the FULL planned field set even when fewer values are handed over: a planned field with no value is HELD, never native (S5)', async () => {
    const claimFields = vi.fn<OwnedFieldsApi['claimFields']>(async () => OK)
    const t = target(api({ claimFields }))
    t.seed('battery', { percentage: 15 })
    await settle()
    expect(claimFields).toHaveBeenCalledWith({
      deviceId: 50,
      capName: 'battery',
      owner: 'blk-1',
      mode: 'add',
      fields: FIELDS,
      values: { percentage: 15 },
    })
  })

  it('a rejected claim is reported; the NEXT write is a claim again, with every field (S5)', async () => {
    const claimFields = vi
      .fn<OwnedFieldsApi['claimFields']>()
      .mockRejectedValueOnce(new Error('hub down'))
      .mockResolvedValue(OK)
    const patchOwnedFields = vi.fn(async () => OK)
    const t = target(api({ claimFields, patchOwnedFields }))
    const failures: [string, TargetAsyncFailure][] = []
    t.onAsyncFailure((cap, f) => failures.push([cap, f]))
    t.seed('battery', SEED)
    await settle()
    expect(failures).toEqual([['battery', { kind: 'threw', error: 'hub down' }]])
    t.patch('battery', SEED) // what `patchWholeCap` sends: every current value
    await settle()
    expect(claimFields).toHaveBeenCalledTimes(2)
    expect(claimFields.mock.calls[1]?.[0]).toMatchObject({ fields: FIELDS, values: SEED })
    expect(patchOwnedFields).not.toHaveBeenCalled()
  })

  it('not-claimed / field-not-claimed on a patch are escalated BY NAME and the next write re-claims (S5)', async () => {
    const claimFields = vi.fn(async () => OK)
    const patchOwnedFields = vi.fn(
      async (): Promise<ClaimOutcome> => ({
        ok: false,
        code: 'field-not-claimed',
        message: 'battery.percentage is not claimed',
      }),
    )
    const t = target(api({ claimFields, patchOwnedFields }))
    const failures: [string, TargetAsyncFailure][] = []
    t.onAsyncFailure((cap, f) => failures.push([cap, f]))
    t.seed('battery', SEED)
    await settle()
    t.patch('battery', { percentage: 100 })
    await settle()
    expect(failures).toEqual([
      [
        'battery',
        {
          kind: 'refused',
          code: 'field-not-claimed',
          message: 'battery.percentage is not claimed',
        },
      ],
    ])
    t.patch('battery', { ...SEED, percentage: 100 })
    await settle()
    expect(claimFields).toHaveBeenCalledTimes(2)
  })

  it('a refusal that is not about the claim (row-unreadable) is reported but the claim stands: the next write is a patch', async () => {
    const claimFields = vi.fn(async () => OK)
    const patchOwnedFields = vi
      .fn<OwnedFieldsApi['patchOwnedFields']>()
      .mockResolvedValueOnce({ ok: false, code: 'row-unreadable', message: 'disk' })
      .mockResolvedValue(OK)
    const t = target(api({ claimFields, patchOwnedFields }))
    const failures: [string, TargetAsyncFailure][] = []
    t.onAsyncFailure((cap, f) => failures.push([cap, f]))
    t.seed('battery', SEED)
    await settle()
    t.patch('battery', { percentage: 1 })
    await settle()
    expect(failures).toEqual([
      ['battery', { kind: 'refused', code: 'row-unreadable', message: 'disk' }],
    ])
    t.patch('battery', SEED)
    await settle()
    expect(claimFields).toHaveBeenCalledTimes(1)
    expect(patchOwnedFields).toHaveBeenCalledTimes(2)
  })

  it('three rapid patches while one is in flight → two RPCs, the second carrying the MERGE (later keys win) and merged: 2', async () => {
    let release: () => void = () => undefined
    const patchOwnedFields = vi
      .fn<OwnedFieldsApi['patchOwnedFields']>()
      .mockImplementationOnce(
        () =>
          new Promise<ClaimOutcome>((r) => {
            release = () => r(OK)
          }),
      )
      .mockResolvedValue(OK)
    const t = target(api({ patchOwnedFields }))
    t.seed('battery', SEED)
    await settle()
    t.patch('battery', { percentage: 1 }) // in flight
    t.patch('battery', { percentage: 2 })
    t.patch('battery', { charging: 'dc' })
    t.patch('battery', { percentage: 3 })
    release()
    await settle()
    expect(patchOwnedFields).toHaveBeenCalledTimes(2)
    expect(patchOwnedFields.mock.calls[1]?.[0]).toMatchObject({
      values: { percentage: 3, charging: 'dc' },
    })
    expect(
      log.lines
        .filter((l) => l.message === 'composed write landed after absorbing merged patches')
        .at(-1)?.extras,
    ).toMatchObject({ tags: { deviceId: 50 }, meta: { cap: 'battery', merged: 2 } })
  })

  it('a seed while a write is in flight REPLACES the pending values wholly', async () => {
    let release: () => void = () => undefined
    const claimFields = vi
      .fn<OwnedFieldsApi['claimFields']>()
      .mockImplementationOnce(
        () =>
          new Promise<ClaimOutcome>((r) => {
            release = () => r(OK)
          }),
      )
      .mockResolvedValue(OK)
    const patchOwnedFields = vi.fn<OwnedFieldsApi['patchOwnedFields']>(async () => OK)
    const t = target(api({ claimFields, patchOwnedFields }))
    t.seed('battery', SEED) // in flight
    t.patch('battery', { percentage: 1 })
    t.seed('battery', { ...SEED, percentage: 7 })
    release()
    await settle()
    expect(claimFields).toHaveBeenCalledTimes(1)
    expect(patchOwnedFields).toHaveBeenCalledTimes(1)
    expect(patchOwnedFields.mock.calls[0]?.[0]).toMatchObject({
      values: { ...SEED, percentage: 7 },
    })
  })

  it('two caps have two independent chains', async () => {
    let release: () => void = () => undefined
    const claimFields = vi
      .fn<OwnedFieldsApi['claimFields']>()
      .mockImplementationOnce(
        () =>
          new Promise<ClaimOutcome>((r) => {
            release = () => r(OK)
          }),
      )
      .mockResolvedValue(OK)
    const t = target(api({ claimFields }))
    t.seed('battery', SEED) // in flight
    t.seed('binary', { on: true })
    await settle()
    expect(claimFields).toHaveBeenCalledTimes(2)
    release()
    await settle()
  })

  it('arms no timer', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const t = target(
      api({
        claimFields: vi.fn<OwnedFieldsApi['claimFields']>().mockRejectedValue(new Error('x')),
      }),
    )
    t.seed('battery', SEED)
    expect(spy).not.toHaveBeenCalled()
  })

  it('setAvailable is a no-op: device-status belongs to the native device', () => {
    const t = target(api({}))
    expect(() => t.setAvailable(false)).not.toThrow()
    expect(log.lines).toEqual([])
  })

  it('a failure nobody listens to is logged, never silent (D391)', async () => {
    const t = target(
      api({
        claimFields: vi
          .fn<OwnedFieldsApi['claimFields']>()
          .mockRejectedValue(new Error('hub down')),
      }),
    )
    t.seed('battery', SEED)
    await settle()
    const line = log.lines.find((l) => l.level === 'warn')
    expect(line?.extras).toMatchObject({
      tags: { deviceId: 50 },
      meta: { cap: 'battery', error: 'hub down' },
    })
  })
})

describe('withhold — a released field is handed back (S1b)', () => {
  it('withhold narrows the claim to the remaining fields; nothing left → releaseClaim; [] re-widens', async () => {
    const a = api({})
    const t = new OwnedFieldsTarget({
      deviceId: 51,
      owner: 'blk-2',
      modeOf: () => 'replace',
      fieldsOf: () => ['on'],
      api: a,
      logger: log.logger,
    })
    t.seed('binary', { on: true })
    await settle()
    expect(t.withhold('binary', ['on'])).toEqual({ ok: true })
    await settle()
    expect(a.releaseClaim).toHaveBeenCalledWith({ deviceId: 51, capName: 'binary', owner: 'blk-2' })
    t.withhold('binary', [])
    t.patch('binary', { on: false })
    await settle()
    expect(a.claimFields).toHaveBeenLastCalledWith({
      deviceId: 51,
      capName: 'binary',
      owner: 'blk-2',
      mode: 'replace',
      fields: ['on'],
      values: { on: false },
    })
  })

  it('withhold of ONE of two fields re-claims the other alone', async () => {
    const a = api({})
    const t = target(a, ['percentage', 'charging'])
    t.seed('battery', { percentage: 15, charging: 'dc' })
    await settle()
    t.withhold('battery', ['charging'])
    t.patch('battery', { percentage: 80 })
    await settle()
    expect(a.releaseClaim).not.toHaveBeenCalled()
    expect(a.claimFields).toHaveBeenLastCalledWith(
      expect.objectContaining({ fields: ['percentage'], values: { percentage: 80 } }),
    )
  })

  it('a claim in flight when withhold runs does NOT land the old field set: the next write is the narrowed claim (I-2)', async () => {
    let release: () => void = () => undefined
    const claimFields = vi
      .fn<OwnedFieldsApi['claimFields']>()
      .mockImplementationOnce(
        () =>
          new Promise<ClaimOutcome>((r) => {
            release = () => r(OK)
          }),
      )
      .mockResolvedValue(OK)
    const patchOwnedFields = vi.fn<OwnedFieldsApi['patchOwnedFields']>(async () => OK)
    const t = target(api({ claimFields, patchOwnedFields }), ['percentage', 'charging'])
    t.seed('battery', { percentage: 15, charging: 'dc' }) // claim [percentage, charging] in flight
    t.withhold('battery', ['charging'])
    release()
    await settle()
    t.patch('battery', { percentage: 80 })
    await settle()
    expect(patchOwnedFields).not.toHaveBeenCalled()
    expect(claimFields).toHaveBeenCalledTimes(2)
    expect(claimFields).toHaveBeenLastCalledWith(
      expect.objectContaining({ fields: ['percentage'], values: { percentage: 80 } }),
    )
  })

  it('a value for a withheld field is never sent — even when the runtime hands it over', async () => {
    const a = api({})
    const t = target(a, ['percentage', 'charging'])
    t.seed('battery', { percentage: 15, charging: 'dc' })
    await settle()
    t.withhold('battery', ['charging'])
    t.patch('battery', { percentage: 80, charging: 'ac' })
    await settle()
    expect(a.claimFields).toHaveBeenLastCalledWith(
      expect.objectContaining({ fields: ['percentage'], values: { percentage: 80 } }),
    )
  })

  it('releaseClaim answering not-claimed is nothing to hand back — not a failure', async () => {
    const releaseClaim = vi.fn(
      async (): Promise<ClaimOutcome> => ({
        ok: false,
        code: 'not-claimed',
        message: 'nothing claimed',
      }),
    )
    const t = target(api({ releaseClaim }), ['on'])
    const failures: [string, TargetAsyncFailure][] = []
    t.onAsyncFailure((cap, f) => failures.push([cap, f]))
    t.withhold('binary', ['on'])
    await settle()
    expect(releaseClaim).toHaveBeenCalledTimes(1)
    expect(failures).toEqual([])
  })

  it('a releaseClaim that throws is reported so the runtime re-sends the withhold', async () => {
    const releaseClaim = vi
      .fn<OwnedFieldsApi['releaseClaim']>()
      .mockRejectedValue(new Error('hub down'))
    const t = target(api({ releaseClaim }), ['on'])
    const failures: [string, TargetAsyncFailure][] = []
    t.onAsyncFailure((cap, f) => failures.push([cap, f]))
    t.seed('binary', { on: true })
    await settle()
    t.withhold('binary', ['on'])
    await settle()
    expect(failures).toEqual([['binary', { kind: 'threw', error: 'hub down' }]])
  })
})
