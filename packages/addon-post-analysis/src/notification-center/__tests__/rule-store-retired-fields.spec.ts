/**
 * D692 §9 — a stored rule that still carries `waitForEnhancement` / `groupIdleSec` is PROJECTED
 * on read (never written back), and an older client's `clear` of those keys strips the stored
 * row. Every case runs through a real `NcRuleStore` over the in-memory records world seeded with RAW
 * rows: a fake that handed the store already-parsed rules would hide exactly the Zod strip this
 * task exists to get ahead of.
 */
import type { InMemoryRecords } from '@camstack/types'
import { ncRecordKinds } from '../record-kinds.js'
import { describe, expect, it } from 'vitest'
import { NcRuleUpdateInputSchema } from '@camstack/types'
import { instrumentRecords } from '../../pipeline-analytics/__tests__/fake-records.js'
import {
  makeLogRecorder,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcRuleStore } from '../rule-store.js'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { projectRetiredRuleFields } from '../rule-retired-fields.js'

const PROJECTED_LINE = 'rule carries a retired delivery field — projected'

function rawRule(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name: `rule ${id}`,
    enabled: true,
    delivery: 'immediate',
    targets: [{ targetId: 'tgt-1' }],
    conditions: { classes: ['person'] },
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
    disabledTargetIds: [],
    ...overrides,
  }
}

/** A stored rule row exactly as the engine holds it: the body, the id being the record key. */
function seedRule(world: InMemoryRecords, id: string, overrides: Record<string, unknown>): void {
  const { id: _key, ...body } = rawRule(id, overrides)
  world.seed('rules', { id, data: body })
}

function storedRule(world: InMemoryRecords, id: string): Record<string, unknown> {
  const row = ncTable(world, 'rules').get(id)
  if (row === undefined) throw new Error(`no stored rule ${id}`)
  return row
}

/** A store over the world, with every write it sends counted. */
function makeStore(
  world: InMemoryRecords,
  logger = makeSilentLogger(),
): { readonly store: NcRuleStore; readonly writes: () => number } {
  const counted = instrumentRecords(world.records)
  const store = new NcRuleStore({
    kind: counted.records.kind(ncRecordKinds.rules),
    logger,
    now: () => 5_000,
  })
  return {
    store,
    writes: () => counted.calls('put') + counted.calls('patch') + counted.calls('delete'),
  }
}

describe('projectRetiredRuleFields (pure)', () => {
  const immediate = { delivery: 'immediate', conditions: { classes: ['person'] } }

  it('is unchanged when neither retired key is stored', () => {
    expect(projectRetiredRuleFields(immediate)).toEqual({ kind: 'unchanged' })
  })

  it('an explicit groupingSec wins; the retired keys are only dropped', () => {
    const projection = projectRetiredRuleFields({
      ...immediate,
      conditions: { identities: [] },
      waitForEnhancement: true,
      groupIdleSec: 40,
      groupingSec: 12,
    })
    expect(projection).toEqual({
      kind: 'projected',
      dropped: ['waitForEnhancement', 'groupIdleSec'],
      from: { waitForEnhancement: true, groupIdleSec: 40 },
    })
  })

  it('waitForEnhancement beats groupIdleSec when both would set the window', () => {
    const projection = projectRetiredRuleFields({
      ...immediate,
      conditions: { plates: { values: [] } },
      waitForEnhancement: true,
      groupIdleSec: 40,
    })
    expect(projection.kind === 'projected' && projection.groupingSec).toBe(20)
  })

  it('clamps groupIdleSec to the window bounds and drops zero', () => {
    const at = (groupIdleSec: number): number | undefined => {
      const projection = projectRetiredRuleFields({ ...immediate, groupIdleSec })
      return projection.kind === 'projected' ? projection.groupingSec : undefined
    }
    expect(at(2)).toBe(5)
    expect(at(30)).toBe(30)
    expect(at(600)).toBe(60)
    expect(at(0)).toBeUndefined()
  })

  it('a retired key on a rule no window applies to is dropped, never promoted', () => {
    const trackEnd = projectRetiredRuleFields({
      delivery: 'track-end',
      conditions: { identities: [] },
      waitForEnhancement: true,
      groupIdleSec: 30,
    })
    expect(trackEnd).toEqual({
      kind: 'projected',
      dropped: ['waitForEnhancement', 'groupIdleSec'],
      from: { waitForEnhancement: true, groupIdleSec: 30 },
    })
    const sound = projectRetiredRuleFields({
      delivery: 'immediate',
      conditions: { audio: {}, identities: [] },
      waitForEnhancement: true,
    })
    expect(sound.kind === 'projected' && sound.groupingSec).toBeUndefined()
  })
})

describe('NcRuleStore — retired fields are projected on read (D692 §9)', () => {
  it('waitForEnhancement:true on an immediate rule WITH identities → the default window', async () => {
    const world = makeNcRecords()
    seedRule(world, 'wait-named', {
      conditions: { classes: ['person'], identities: ['id-1'] },
      waitForEnhancement: true,
    })
    const { store } = makeStore(world)
    await store.load()
    expect(store.get('wait-named')?.groupingSec).toBe(20)
  })

  it('waitForEnhancement:true on an immediate rule WITH plates → the default window', async () => {
    const world = makeNcRecords()
    seedRule(world, 'wait-plate', {
      conditions: { classes: ['car'], plates: { values: [] } },
      waitForEnhancement: true,
    })
    const { store } = makeStore(world)
    await store.load()
    expect(store.get('wait-plate')?.groupingSec).toBe(20)
  })

  it('waitForEnhancement:true without a recognition scope is dropped', async () => {
    const world = makeNcRecords()
    seedRule(world, 'wait-plain', { waitForEnhancement: true })
    const { store } = makeStore(world)
    await store.load()
    expect(store.get('wait-plain')).not.toBeNull()
    expect(store.get('wait-plain')).not.toHaveProperty('groupingSec')
  })

  it('groupIdleSec > 0 on an immediate detection rule → clamp(groupIdleSec, 5, 60)', async () => {
    const world = makeNcRecords()
    seedRule(world, 'idle-30', { groupIdleSec: 30 })
    seedRule(world, 'idle-2', { groupIdleSec: 2 })
    seedRule(world, 'idle-300', { groupIdleSec: 300 })
    seedRule(world, 'idle-0', { groupIdleSec: 0 })
    const { store } = makeStore(world)
    await store.load()
    expect(store.get('idle-30')?.groupingSec).toBe(30)
    expect(store.get('idle-2')?.groupingSec).toBe(5)
    expect(store.get('idle-300')?.groupingSec).toBe(60)
    expect(store.get('idle-0')).not.toHaveProperty('groupingSec')
  })

  it('groupIdleSec on a track-end rule is dropped', async () => {
    const world = makeNcRecords()
    seedRule(world, 'idle-track-end', { delivery: 'track-end', groupIdleSec: 30 })
    const { store } = makeStore(world)
    await store.load()
    expect(store.get('idle-track-end')).not.toBeNull()
    expect(store.get('idle-track-end')).not.toHaveProperty('groupingSec')
  })

  it('an explicit groupingSec is kept over a derived one', async () => {
    const world = makeNcRecords()
    seedRule(world, 'both', { groupIdleSec: 30, groupingSec: 12 })
    const { store } = makeStore(world)
    await store.load()
    expect(store.get('both')?.groupingSec).toBe(12)
  })

  it('the system-event hub row (waitForEnhancement:false) is dropped, no window', async () => {
    const world = makeNcRecords()
    seedRule(world, 'sys', {
      name: 'system — devices',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['device-offline'] } },
      waitForEnhancement: false,
    })
    const { store } = makeStore(world)
    await store.load()
    const rule = store.get('sys')
    expect(rule?.name).toBe('system — devices')
    expect(rule).not.toHaveProperty('groupingSec')
    expect(rule).not.toHaveProperty('waitForEnhancement')
  })

  it('NEVER writes back: the stored row still carries the retired keys after load()', async () => {
    const world = makeNcRecords()
    seedRule(world, 'kept', {
      conditions: { classes: ['person'], identities: ['id-1'] },
      waitForEnhancement: true,
      groupIdleSec: 30,
    })
    const { store, writes } = makeStore(world)
    await store.load()
    await store.load()
    expect(store.get('kept')?.groupingSec).toBe(20)
    expect(writes()).toBe(0)
    const raw = storedRule(world, 'kept')
    expect(raw['waitForEnhancement']).toBe(true)
    expect(raw['groupIdleSec']).toBe(30)
    expect(raw).not.toHaveProperty('groupingSec')
  })

  it('logs each projected rule ONCE per process, at INFO, across reloads', async () => {
    const world = makeNcRecords()
    seedRule(world, 'logged', {
      conditions: { classes: ['person'], identities: ['id-1'] },
      waitForEnhancement: true,
    })
    seedRule(world, 'untouched', {})
    const recorder = makeLogRecorder()
    const { store } = makeStore(world, recorder.logger)
    await store.load()
    await store.load()
    const lines = recorder.entries.filter((entry) => entry.message === PROJECTED_LINE)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('info')
    expect(lines[0]?.extras?.meta).toMatchObject({
      ruleId: 'logged',
      from: { waitForEnhancement: true },
      groupingSec: 20,
    })
  })
})

describe('NcRuleStore.update — clearing a retired key strips the STORED row (D692 §2.3)', () => {
  it('update(id, {}, [waitForEnhancement]) succeeds and the stored row loses the key', async () => {
    const world = makeNcRecords()
    seedRule(world, 'clr', {
      conditions: { classes: ['person'], identities: ['id-1'] },
      waitForEnhancement: true,
      groupIdleSec: 30,
    })
    const { store } = makeStore(world)
    await store.load()
    const result = await store.update('clr', {}, ['waitForEnhancement'])
    const raw = storedRule(world, 'clr')
    expect(raw).not.toHaveProperty('waitForEnhancement')
    // The OTHER retired key was not named, so it is still PROJECTED. A records body cannot
    // hold a retired key (the kind's schema strips it on write), so the window it carries is
    // what the rewritten row keeps: stored as the explicit `groupingSec`, or the next load
    // would lose the operator's 30 s.
    expect(result.groupingSec).toBe(30)
    expect(store.get('clr')?.groupingSec).toBe(30)
    expect(raw).not.toHaveProperty('groupIdleSec')
    expect(raw['groupingSec']).toBe(30)
  })

  it('clearing the key that carried the projection removes the projection too', async () => {
    const world = makeNcRecords()
    seedRule(world, 'wait-only', {
      conditions: { classes: ['person'], identities: ['id-1'] },
      waitForEnhancement: true,
    })
    const { store } = makeStore(world)
    await store.load()
    expect(store.get('wait-only')?.groupingSec).toBe(20)
    const result = await store.update('wait-only', {}, ['waitForEnhancement'])
    expect(result).not.toHaveProperty('groupingSec')
    expect(store.get('wait-only')).not.toHaveProperty('groupingSec')
    const raw = storedRule(world, 'wait-only')
    expect(raw).not.toHaveProperty('waitForEnhancement')
    expect(raw).not.toHaveProperty('groupingSec')
    expect(raw['name']).toBe('rule wait-only')
  })

  it('a retired key mixed with a normal one strips the raw key, then merges the typed rule', async () => {
    const world = makeNcRecords()
    seedRule(world, 'mixed', {
      groupIdleSec: 40,
      template: { title: 'hello' },
    })
    const { store } = makeStore(world)
    await store.load()
    const result = await store.update('mixed', {}, ['groupIdleSec', 'template'])
    expect(result).not.toHaveProperty('template')
    expect(result).not.toHaveProperty('groupingSec')
    const raw = storedRule(world, 'mixed')
    expect(raw).not.toHaveProperty('groupIdleSec')
    expect(raw).not.toHaveProperty('template')
    expect(raw).not.toHaveProperty('groupingSec')
  })

  it('a patch still conflicts with a NORMAL cleared key, never with a retired one', async () => {
    const world = makeNcRecords()
    seedRule(world, 'conflict', { groupIdleSec: 40, groupingSec: 12 })
    const { store } = makeStore(world)
    await store.load()
    await expect(store.update('conflict', { groupingSec: 20 }, ['groupingSec'])).rejects.toThrow(
      /both sets and clears 'groupingSec'/,
    )
    await expect(
      store.update('conflict', { groupingSec: 20 }, ['groupIdleSec']),
    ).resolves.toMatchObject({
      groupingSec: 20,
    })
  })

  it('clearing a retired key that is not stored is a no-op that still succeeds', async () => {
    const world = makeNcRecords()
    seedRule(world, 'absent', {})
    const { store, writes } = makeStore(world)
    await store.load()
    const result = await store.update('absent', {}, ['waitForEnhancement', 'groupIdleSec'])
    expect(result.id).toBe('absent')
    expect(writes()).toBe(0)
  })

  it("an older client's clear of a retired key parses through NcRuleUpdateInputSchema", () => {
    for (const key of ['waitForEnhancement', 'groupIdleSec'] as const) {
      const parsed = NcRuleUpdateInputSchema.safeParse({ ruleId: 'r1', patch: {}, clear: [key] })
      expect(parsed.success).toBe(true)
    }
  })
})
