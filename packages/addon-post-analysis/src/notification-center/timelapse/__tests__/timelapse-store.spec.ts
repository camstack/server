/**
 * TimelapseStore unit tests (task A6) — declared-collection persistence,
 * caller-stamped create, SERVER-DERIVED ownership, immutable update with
 * re-validation, `markGenerated` round-trip and invalid-row resilience.
 *
 * Mirrors `rule-store.spec.ts` (the `NcRuleStore` precedent).
 */
import { ncRecordKinds } from '../../record-kinds.js'
import { makeNcRecords, ncTable } from '../../__tests__/support/nc-test-deps.js'
import { beforeEach, describe, expect, it } from 'vitest'
import type { InMemoryRecords, TimelapseRuleInput, TimelapseRulePatch } from '@camstack/types'
import {
  readTimelapseGeneratedAt,
  TimelapseRuleInputSchema,
  TimelapseRuleSchema,
} from '@camstack/types'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import { TimelapseStore } from '../timelapse-store.js'

const SCHEDULE = { windows: [{ days: [1, 2, 3, 4, 5], startMinute: 480, endMinute: 1080 }] }

function makeInput(overrides: Record<string, unknown> = {}): TimelapseRuleInput {
  return TimelapseRuleInputSchema.parse({
    name: 'driveway daylight',
    deviceIds: [601],
    schedule: SCHEDULE,
    targets: [{ targetId: 'tgt-1' }],
    ...overrides,
  })
}

describe('TimelapseStore', () => {
  let world: InMemoryRecords
  let store: TimelapseStore
  let now: number

  beforeEach(async () => {
    world = makeNcRecords()
    now = 1_000
    let seq = 0
    store = new TimelapseStore({
      kind: world.records.kind(ncRecordKinds['timelapse-rules']),
      logger: makeSilentLogger(),
      now: () => now,
      newId: () => `tl-${(seq += 1)}`,
    })
  })

  it('create stamps id, createdBy (caller), timestamps and persists the full blob', async () => {
    const rule = await store.create(makeInput(), 'admin-42')
    expect(rule.id).toBe('tl-1')
    expect(rule.createdBy).toBe('admin-42')
    expect(rule.createdAt).toBe(1_000)
    expect(rule.updatedAt).toBe(1_000)
    expect(rule.cadenceSec).toBe(15)
    expect(rule.framerate).toBe(10)
    expect(rule.lastGeneratedAt).toBeUndefined()
    const row = ncTable(world, 'timelapse-rules').get('tl-1')!
    expect(row['name']).toBe('driveway daylight')
    expect(row['enabled']).toBe(true)
    expect(row['updatedAt']).toBe(1_000)
    expect(TimelapseRuleSchema.parse({ ...row, id: 'tl-1' }).id).toBe('tl-1')
  })

  it('create derives ownerUserId from the SERVER-supplied owner, never the input', async () => {
    // A forged `ownerUserId` on the raw client payload is already stripped by
    // the input schema; the store stamps ownership from its own argument.
    const forged: TimelapseRuleInput = makeInput()
    Object.assign(forged, { ownerUserId: 'attacker' })
    const personal = await store.create(forged, 'u1', 'u1')
    expect(personal.ownerUserId).toBe('u1')
    const global = await store.create(makeInput(), 'admin-1')
    expect(global.ownerUserId).toBeUndefined()
  })

  it('create on the ADMIN path (no owner argument) never adopts a forged input owner', async () => {
    // The dangerous pairing: an `ownerUserId` riding on the input blob while
    // the SERVER argument is omitted (admin/global rule). It must not survive —
    // `create` re-parses through the input schema, which carries no ownership.
    // Realistic without an attacker: a "duplicate rule" action passing an
    // existing rule (structurally a `TimelapseRuleInput`) would otherwise clone
    // the ORIGINAL owner.
    const forged: TimelapseRuleInput = makeInput()
    Object.assign(forged, { ownerUserId: 'attacker', createdBy: 'attacker', id: 'forged' })
    const global = await store.create(forged, 'admin-1')
    expect(global.ownerUserId).toBeUndefined()
    expect(global.createdBy).toBe('admin-1')
    expect(global.id).toBe('tl-1')
    // …and the forged owner is not persisted either.
    const persisted = TimelapseRuleSchema.parse({
      ...ncTable(world, 'timelapse-rules').get('tl-1')!,
      id: 'tl-1',
    })
    expect(persisted.ownerUserId).toBeUndefined()
    // The rule must stay globally visible (a forged owner would hide it).
    expect(store.listForOwner('stranger').map((r) => r.id)).toEqual(['tl-1'])
  })

  it('load hydrates persisted rules (fresh instance over the same store)', async () => {
    await store.create(makeInput(), 'admin-42')
    const store2 = new TimelapseStore({
      kind: world.records.kind(ncRecordKinds['timelapse-rules']),
      logger: makeSilentLogger(),
    })
    await store2.load()
    expect(store2.list()).toHaveLength(1)
    expect(store2.get('tl-1')?.name).toBe('driveway daylight')
  })

  /**
   * A rule with no `createdAt` has no eligibility floor, and a rule with no
   * floor back-fills a window that closed before anyone configured it. Reading
   * such a row as "born at load" gives it a floor without dropping the rule.
   */
  it('load stamps a MISSING createdAt with the load time (legacy rows get a floor)', async () => {
    const created = await store.create(makeInput(), 'admin-42')
    const { createdAt: _dropped, id: _id, ...legacy } = created
    world.seed('timelapse-rules', { id: created.id, data: legacy })
    let loadNow = 500_000
    const store2 = new TimelapseStore({
      kind: world.records.kind(ncRecordKinds['timelapse-rules']),
      logger: makeSilentLogger(),
      now: () => loadNow,
    })
    await store2.load()
    expect(store2.get(created.id)?.createdAt).toBe(500_000)

    // The floor must not CREEP: a periodic refresh re-reading the same legacy
    // row keeps the first synthesised birth, or a rule whose row is still
    // legacy would be pushed past every window it was ever offered.
    loadNow = 900_000
    await store2.load()
    expect(store2.get(created.id)?.createdAt).toBe(500_000)
  })

  it('load skips rows whose rule JSON no longer validates', async () => {
    await store.create(makeInput(), 'admin-42')
    world.seed('timelapse-rules', { id: 'broken', data: { junk: 1 } })
    const store2 = new TimelapseStore({
      kind: world.records.kind(ncRecordKinds['timelapse-rules']),
      logger: makeSilentLogger(),
    })
    await store2.load()
    expect(store2.list().map((r) => r.id)).toEqual(['tl-1'])
  })

  it('update merges immutably, bumps updatedAt and preserves provenance', async () => {
    const created = await store.create(makeInput(), 'admin-42', 'u1')
    now = 2_000
    const updated = await store.update(created.id, { name: 'renamed', cadenceSec: 60 })
    expect(updated).not.toBe(created)
    expect(created.name).toBe('driveway daylight') // original untouched
    expect(updated.name).toBe('renamed')
    expect(updated.cadenceSec).toBe(60)
    expect(updated.createdAt).toBe(1_000)
    expect(updated.createdBy).toBe('admin-42')
    expect(updated.ownerUserId).toBe('u1')
    expect(updated.updatedAt).toBe(2_000)
    expect(store.get(created.id)?.name).toBe('renamed')
  })

  it('update can never re-own a rule or forge its identity/generation state', async () => {
    const created = await store.create(makeInput(), 'admin-42', 'u1')
    await store.markGenerated(created.id, 601, 4_000)
    const forged: TimelapseRulePatch = { name: 'renamed' }
    Object.assign(forged, {
      id: 'forged',
      ownerUserId: 'attacker',
      createdBy: 'attacker',
      createdAt: 0,
      lastGeneratedAt: 0,
    })
    const updated = await store.update(created.id, forged)
    expect(updated.id).toBe(created.id)
    expect(updated.ownerUserId).toBe('u1')
    expect(updated.createdBy).toBe('admin-42')
    expect(updated.createdAt).toBe(1_000)
    expect(updated.lastGeneratedAt).toBe(4_000)
    expect(updated.name).toBe('renamed')
  })

  it('update rejects a patch that would persist an invalid rule', async () => {
    const created = await store.create(makeInput(), 'u')
    // Out-of-bounds value on a hand-built (unparsed) patch — the store's
    // re-validation is the last line of defence.
    const outOfBounds: TimelapseRulePatch = {}
    Object.assign(outOfBounds, { framerate: 99 })
    await expect(store.update(created.id, outOfBounds)).rejects.toThrow()
    expect(store.get(created.id)?.framerate).toBe(10)
  })

  it('update clears the template with an explicit null and persists it cleared', async () => {
    const created = await store.create(makeInput({ template: { title: 't', body: 'b' } }), 'u')
    expect(created.template?.title).toBe('t')
    // An absent key leaves the template unchanged…
    const renamed = await store.update(created.id, { name: 'renamed' })
    expect(renamed.template?.title).toBe('t')
    // …an explicit null CLEARS it (the only JSON-survivable clear signal).
    const cleared = await store.update(created.id, { template: null })
    expect(cleared.template).toBeUndefined()
    expect('template' in cleared).toBe(false)
    const store2 = new TimelapseStore({
      kind: world.records.kind(ncRecordKinds['timelapse-rules']),
      logger: makeSilentLogger(),
    })
    await store2.load()
    expect(store2.get(created.id)?.template).toBeUndefined()
  })

  it('update of an unknown rule throws', async () => {
    await expect(store.update('nope', { name: 'x' })).rejects.toThrow('not found')
  })

  describe('update with a clear list', () => {
    // The patch MERGES over the stored rule, so an omitted key survives: an
    // editor that emptied the caption, saved and reopened found it back. The
    // `clear` list is how an optional field is REMOVED — the same design as
    // `NcRuleStore.update` (Plan A).
    const FULL = {
      template: { title: 'Notte', body: '{{detectionSummary}}' },
      previewText: 'Notte {{camera}}',
      reportClasses: ['person'],
      denseCadenceSec: 0.5,
      minDwellSec: 1,
    }

    it('REMOVES every named key, and the removal survives a reload', async () => {
      const created = await store.create(makeInput(FULL), 'u')
      const cleared = await store.update(created.id, {}, [
        'template',
        'previewText',
        'reportClasses',
        'denseCadenceSec',
        'minDwellSec',
      ])
      for (const key of [
        'template',
        'previewText',
        'reportClasses',
        'denseCadenceSec',
        'minDwellSec',
      ]) {
        expect(key in cleared).toBe(false)
      }
      const store2 = new TimelapseStore({
        kind: world.records.kind(ncRecordKinds['timelapse-rules']),
        logger: makeSilentLogger(),
      })
      await store2.load()
      const reloaded = store2.get(created.id)
      expect(reloaded?.previewText).toBeUndefined()
      expect(reloaded?.reportClasses).toBeUndefined()
      expect(reloaded?.denseCadenceSec).toBeUndefined()
      expect(reloaded?.minDwellSec).toBeUndefined()
      expect(reloaded?.template).toBeUndefined()
    })

    it('clears ONLY what it names — the rest of the rule is untouched', async () => {
      const created = await store.create(makeInput(FULL), 'u')
      const cleared = await store.update(created.id, { name: 'renamed' }, ['previewText'])
      expect(cleared.name).toBe('renamed')
      expect('previewText' in cleared).toBe(false)
      expect(cleared.template).toEqual(FULL.template)
      expect(cleared.reportClasses).toEqual(['person'])
      expect(cleared.denseCadenceSec).toBe(0.5)
      expect(cleared.minDwellSec).toBe(1)
    })

    it('REFUSES a key that is both set and cleared, and writes nothing', async () => {
      const created = await store.create(makeInput(FULL), 'u')
      await expect(
        store.update(created.id, { previewText: 'nuovo' }, ['previewText']),
      ).rejects.toThrow(/both sets and clears 'previewText'/)
      await expect(
        store.update(created.id, { template: { title: 'x' } }, ['template']),
      ).rejects.toThrow(/both sets and clears 'template'/)
      expect(store.get(created.id)?.previewText).toBe('Notte {{camera}}')
      expect(store.get(created.id)?.template).toEqual(FULL.template)
    })

    it('accepts template: null beside a clear of template — both say "remove"', async () => {
      const created = await store.create(makeInput(FULL), 'u')
      const cleared = await store.update(created.id, { template: null }, ['template'])
      expect('template' in cleared).toBe(false)
    })

    it('an empty clear list is the plain merge', async () => {
      const created = await store.create(makeInput(FULL), 'u')
      const renamed = await store.update(created.id, { name: 'renamed' }, [])
      expect(renamed.previewText).toBe('Notte {{camera}}')
      expect(renamed.denseCadenceSec).toBe(0.5)
    })
  })

  it('setEnabled toggles the rule and listEnabled reflects it', async () => {
    const a = await store.create(makeInput({ name: 'a' }), 'u')
    await store.create(makeInput({ name: 'b' }), 'u')
    expect(
      store
        .listEnabled()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['a', 'b'])
    await store.setEnabled(a.id, false)
    expect(store.listEnabled().map((r) => r.name)).toEqual(['b'])
  })

  it('delete removes cache + persisted row; unknown ids are a no-op', async () => {
    const rule = await store.create(makeInput(), 'u')
    await store.delete(rule.id)
    expect(store.get(rule.id)).toBeNull()
    expect(ncTable(world, 'timelapse-rules').has(rule.id)).toBe(false)
    await expect(store.delete('nope')).resolves.toBeUndefined()
  })
})

describe('TimelapseStore ownership', () => {
  let world: InMemoryRecords
  let store: TimelapseStore

  beforeEach(async () => {
    world = makeNcRecords()
    let seq = 0
    store = new TimelapseStore({
      kind: world.records.kind(ncRecordKinds['timelapse-rules']),
      logger: makeSilentLogger(),
      newId: () => `tl-${(seq += 1)}`,
    })
  })

  it('listForOwner returns own personal + global rules only', async () => {
    await store.create(makeInput({ name: 'mine' }), 'u1', 'u1')
    await store.create(makeInput({ name: 'global' }), 'admin-1')
    await store.create(makeInput({ name: 'other' }), 'u2', 'u2')
    expect(
      store
        .listForOwner('u1')
        .map((r) => r.name)
        .sort(),
    ).toEqual(['global', 'mine'])
  })

  it('a global rule is visible to every owner; list() (admin path) sees all', async () => {
    await store.create(makeInput({ name: 'mine' }), 'u1', 'u1')
    await store.create(makeInput({ name: 'global' }), 'admin-1')
    await store.create(makeInput({ name: 'other' }), 'u2', 'u2')
    expect(store.listForOwner('stranger').map((r) => r.name)).toEqual(['global'])
    expect(
      store
        .list()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['global', 'mine', 'other'])
  })

  it('isOwnedBy gates a mutation: global rules are admin-only, personal owner-only', async () => {
    const personal = await store.create(makeInput({ name: 'mine' }), 'u1', 'u1')
    const global = await store.create(makeInput({ name: 'global' }), 'admin-1')
    expect(store.isOwnedBy(personal.id, 'u1')).toBe(true)
    expect(store.isOwnedBy(personal.id, 'u2')).toBe(false)
    expect(store.isOwnedBy(global.id, 'u1')).toBe(false)
    expect(store.isOwnedBy('nope', 'u1')).toBe(false)
  })
})

describe('TimelapseStore.markGenerated', () => {
  let world: InMemoryRecords
  let store: TimelapseStore
  let now: number

  beforeEach(async () => {
    world = makeNcRecords()
    now = 1_000
    let seq = 0
    store = new TimelapseStore({
      kind: world.records.kind(ncRecordKinds['timelapse-rules']),
      logger: makeSilentLogger(),
      now: () => now,
      newId: () => `tl-${(seq += 1)}`,
    })
  })

  it('records lastGeneratedAt and persists it across a reload (regeneration guard state)', async () => {
    const rule = await store.create(makeInput(), 'admin-1')
    expect(rule.lastGeneratedAt).toBeUndefined()
    const marked = await store.markGenerated(rule.id, 601, 5_000)
    expect(marked.lastGeneratedAt).toBe(5_000)
    const store2 = new TimelapseStore({
      kind: world.records.kind(ncRecordKinds['timelapse-rules']),
      logger: makeSilentLogger(),
    })
    await store2.load()
    expect(store2.get(rule.id)?.lastGeneratedAt).toBe(5_000)
  })

  it('markGenerated on an unknown rule throws', async () => {
    await expect(store.markGenerated('nope', 601, 1)).rejects.toThrow('not found')
  })

  /**
   * PER-(rule, device) generation state. One rule covers several cameras, and
   * a render that failed for camera B must not be told "already done" because
   * camera A succeeded ninety seconds earlier — which is exactly what a single
   * rule-wide stamp does.
   */
  it('stamps the generation PER DEVICE, leaving the rule’s other cameras unmarked', async () => {
    const rule = await store.create(makeInput({ deviceIds: [601, 101] }), 'admin-1')
    const marked = await store.markGenerated(rule.id, 601, 5_000)
    expect(readTimelapseGeneratedAt(marked, 601)).toBe(5_000)
    expect(readTimelapseGeneratedAt(marked, 101)).toBe(0)
  })

  it('keeps each device’s stamp independent across successive generations', async () => {
    const rule = await store.create(makeInput({ deviceIds: [601, 101] }), 'admin-1')
    await store.markGenerated(rule.id, 601, 5_000)
    const both = await store.markGenerated(rule.id, 101, 9_000)
    expect(readTimelapseGeneratedAt(both, 601)).toBe(5_000)
    expect(readTimelapseGeneratedAt(both, 101)).toBe(9_000)
    // The rule-wide field stays the NEWEST of them (what a UI shows).
    expect(both.lastGeneratedAt).toBe(9_000)
  })

  it('a rule-wide stamp never regresses when an older device generation lands', async () => {
    const rule = await store.create(makeInput({ deviceIds: [601, 101] }), 'admin-1')
    await store.markGenerated(rule.id, 601, 9_000)
    const older = await store.markGenerated(rule.id, 101, 5_000)
    expect(older.lastGeneratedAt).toBe(9_000)
  })

  it('reads a LEGACY rule-wide stamp as every device’s floor (compatible migration)', async () => {
    // Rows written before the per-device map existed carry only
    // `lastGeneratedAt`. Reading them as "never generated" would re-render and
    // re-notify every camera of every rule once, on the deploy that shipped
    // the map.
    const rule = await store.create(makeInput({ deviceIds: [601, 101] }), 'admin-1')
    const legacy = TimelapseRuleSchema.parse({ ...rule, lastGeneratedAt: 7_000 })
    expect(readTimelapseGeneratedAt(legacy, 601)).toBe(7_000)
    expect(readTimelapseGeneratedAt(legacy, 101)).toBe(7_000)
  })

  it('seeds the per-device map from the legacy stamp instead of losing it', async () => {
    const rule = await store.create(makeInput({ deviceIds: [601, 101] }), 'admin-1')
    const { id: _ruleId, ...body } = rule
    world.seed('timelapse-rules', { id: rule.id, data: { ...body, lastGeneratedAt: 7_000 } })
    await store.load()
    const marked = await store.markGenerated(rule.id, 601, 9_000)
    expect(readTimelapseGeneratedAt(marked, 601)).toBe(9_000)
    // 101 keeps the legacy floor rather than falling back to "never".
    expect(readTimelapseGeneratedAt(marked, 101)).toBe(7_000)
  })

  it('markGenerated does NOT bump updatedAt (a generation is not an edit)', async () => {
    const rule = await store.create(makeInput(), 'admin-1')
    now = 50_000
    const marked = await store.markGenerated(rule.id, 601, 5_000)
    expect(marked.updatedAt).toBe(rule.updatedAt)
  })
})
