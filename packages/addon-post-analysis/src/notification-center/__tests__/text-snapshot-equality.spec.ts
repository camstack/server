/**
 * The reload guard that never guarded anything.
 *
 * `reloadTexts()` runs on the 30s rule-reload tick on every notification-centre
 * node, and it is supposed to log "notification texts loaded" ON CHANGE ONLY —
 * the docblock says so explicitly ("A line every reload tick would be noise").
 * The guard it used was:
 *
 *     if (before.language === next.language && before.overrides === next.overrides) return
 *
 * `next` comes from `NcTextCatalogStore.load()`, which `parse()`s the row
 * through zod on every call and therefore hands back a NEW `overrides` object
 * each time. `===` on it is a reference comparison of a value that is rebuilt by
 * construction: it is `false` on every tick, at byte-identical content, forever.
 *
 * Measured on the live hub 2026-08-25: 58 `notification texts loaded` lines in
 * 30 minutes — one every 31 seconds, on a hub whose language had not changed.
 *
 * The repo rule this breaks is the general one: a guard that guards nothing is
 * worse than no guard, because the next reader sees the `if` and believes the
 * condition was considered.
 */
import { ncRecordKinds } from '../record-kinds.js'
import { makeNcRecords } from './support/nc-test-deps.js'
import { describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import { ncTextSnapshotsEqual } from '../text-catalog.js'
import { NcTextCatalogStore } from '../text-catalog-store.js'

async function storeWith(overrides: Record<string, Record<string, string>>): Promise<{
  readonly fake: FakeSettingsStore
  readonly store: NcTextCatalogStore
}> {
  const fake = makeFakeSettingsStore()
  const world = makeNcRecords()
  const store = new NcTextCatalogStore({
    kind: world.records.kind(ncRecordKinds.texts),
    logger: makeSilentLogger(),
  })
  await store.setLanguage('it')
  await store.setOverrides(overrides)
  return { fake, store }
}

describe('the fact that broke the guard', () => {
  it('two loads of an UNCHANGED row hand back DIFFERENT objects', async () => {
    const { store } = await storeWith({ it: { 'occupancy.op.free': 'vuota' } })
    const a = await store.load()
    const b = await store.load()
    expect(b).not.toBe(a)
    expect(b.overrides).not.toBe(a.overrides)
    // …which is exactly why `before.overrides === next.overrides` could never
    // be true, and why the "on CHANGE only" line fired every 31 seconds.
    expect(a.overrides === b.overrides).toBe(false)
  })
})

describe('ncTextSnapshotsEqual — compares the VALUE', () => {
  it('an unchanged document is equal across two loads', async () => {
    const { store } = await storeWith({ it: { 'occupancy.op.free': 'vuota' } })
    expect(ncTextSnapshotsEqual(await store.load(), await store.load())).toBe(true)
  })

  it('a language change is a change', async () => {
    const { store } = await storeWith({ it: { 'occupancy.op.free': 'vuota' } })
    const before = await store.load()
    await store.setLanguage('en')
    expect(ncTextSnapshotsEqual(before, await store.load())).toBe(false)
  })

  it('an added override key is a change', async () => {
    const { store } = await storeWith({ it: { 'occupancy.op.free': 'vuota' } })
    const before = await store.load()
    await store.setOverrides({ it: { 'occupancy.op.free': 'vuota', 'alarm.armed': 'inserito' } })
    expect(ncTextSnapshotsEqual(before, await store.load())).toBe(false)
  })

  it('a REMOVED override key is a change — a shrink must not read as equal', async () => {
    const { store } = await storeWith({ it: { a: '1', b: '2' } })
    const before = await store.load()
    await store.setOverrides({ it: { a: '1' } })
    expect(ncTextSnapshotsEqual(before, await store.load())).toBe(false)
  })

  it('an edited override VALUE is a change', async () => {
    const { store } = await storeWith({ it: { a: '1' } })
    const before = await store.load()
    await store.setOverrides({ it: { a: '2' } })
    expect(ncTextSnapshotsEqual(before, await store.load())).toBe(false)
  })

  it('a whole language added to the override map is a change', async () => {
    const { store } = await storeWith({ it: { a: '1' } })
    const before = await store.load()
    await store.setOverrides({ it: { a: '1' }, en: { a: '1' } })
    expect(ncTextSnapshotsEqual(before, await store.load())).toBe(false)
  })

  it('key ORDER is not a change — a re-parse does not promise an ordering', () => {
    expect(
      ncTextSnapshotsEqual(
        { language: 'it', overrides: { it: { a: '1', b: '2' } } },
        { language: 'it', overrides: { it: { b: '2', a: '1' } } },
      ),
    ).toBe(true)
  })

  it('an empty override map equals another empty one', () => {
    expect(
      ncTextSnapshotsEqual({ language: 'en', overrides: {} }, { language: 'en', overrides: {} }),
    ).toBe(true)
  })
})
