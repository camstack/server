/**
 * D1054 on notification rules: a rule carries operator `tags` on its own row.
 * An edit of any other field must never drop them (a partial `updateRule` patch
 * once reset `conditions` — the same trap would reset tags), a rule stored
 * before tags existed must load byte-for-byte, and the `tags` cap's write
 * (`setTags`) must change nothing but the tags.
 */
import type { InMemoryRecords, NcRuleInput } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { ncRecordKinds } from '../record-kinds.js'
import { NcRuleStore } from '../rule-store.js'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'

/** A field nothing in this spec edits: it must survive every write untouched. */
const MARK_NAME = 'marked rule — person at gate'

function makeInput(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: MARK_NAME,
    delivery: 'immediate',
    targets: [{ targetId: 'tgt-1' }],
    conditions: { classes: ['person'], devices: [102] },
    priority: 4,
    ...overrides,
  })
}

function newStore(world: InMemoryRecords): NcRuleStore {
  let seq = 0
  return new NcRuleStore({
    kind: world.records.kind(ncRecordKinds.rules),
    logger: makeSilentLogger(),
    now: () => 1_000,
    newId: () => `rule-${(seq += 1)}`,
  })
}

describe('NcRuleStore — tags (D1054)', () => {
  let world: InMemoryRecords
  let store: NcRuleStore

  beforeEach(() => {
    world = makeNcRecords()
    store = newStore(world)
  })

  it('create stores tags trimmed and de-duplicated case-insensitively', async () => {
    const rule = await store.create(makeInput({ tags: [' Garden ', 'garden', 'Night'] }), 'u')
    expect(rule.tags).toEqual(['Garden', 'Night'])
    expect(ncTable(world, 'rules').get(rule.id)?.['tags']).toEqual(['Garden', 'Night'])
  })

  it('an edit of another field keeps the tags (partial patch, enable toggle)', async () => {
    const rule = await store.create(makeInput({ tags: ['Garden'] }), 'u')
    const throttled = await store.update(rule.id, {
      throttle: { cooldownSec: 120, scope: 'rule-device' },
    })
    expect(throttled.tags).toEqual(['Garden'])
    expect(throttled.conditions).toEqual({ classes: ['person'], devices: [102] })
    const disabled = await store.setEnabled(rule.id, false)
    expect(disabled.tags).toEqual(['Garden'])
    const renamed = await store.update(rule.id, { name: 'renamed' })
    expect(renamed.tags).toEqual(['Garden'])
    expect(ncTable(world, 'rules').get(rule.id)?.['tags']).toEqual(['Garden'])
  })

  it('setTags changes only the tags; [] removes the key', async () => {
    const rule = await store.create(makeInput({ tags: ['Garden'] }), 'u')
    const tagged = await store.setTags(rule.id, ['Yard', 'yard ', 'Night'])
    expect(tagged).toMatchObject({
      name: MARK_NAME,
      priority: 4,
      conditions: { classes: ['person'], devices: [102] },
      tags: ['Yard', 'Night'],
    })
    const cleared = await store.setTags(rule.id, [])
    expect('tags' in cleared).toBe(false)
    expect(cleared.name).toBe(MARK_NAME)
    expect(ncTable(world, 'rules').get(rule.id)).not.toHaveProperty('tags')
  })

  it('a rule stored before tags existed loads unchanged and stays untagged after an edit', async () => {
    const created = await store.create(makeInput(), 'u')
    const stored = ncTable(world, 'rules').get(created.id)
    expect(stored).not.toHaveProperty('tags')

    const reloaded = newStore(world)
    await reloaded.load()
    const loaded = reloaded.get(created.id)
    expect(loaded).toEqual(created)
    expect(loaded).not.toHaveProperty('tags')

    const edited = await reloaded.update(created.id, { priority: 2 })
    expect(edited).not.toHaveProperty('tags')
    expect(edited.name).toBe(MARK_NAME)
  })
})
