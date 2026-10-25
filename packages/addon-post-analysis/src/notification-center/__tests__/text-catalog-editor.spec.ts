/**
 * NcTextCatalogEditor — the write half of Phase 2, over the REAL durable store
 * and the REAL live catalog.
 *
 * The one property worth a test at all is the one Phase 1 promised and nothing
 * exercised: an override WINS over the shipped file, live, at the next lookup —
 * not at the next reload tick. An operator who renames a word and is told
 * "saved" while the very next notification still says the old one has been lied
 * to, and the difference between the two is a single `catalog.apply` call in
 * this file.
 *
 * NEUTRALISATION (the repo rule: a green test that stays green without the fix
 * is not a test): delete the `this.catalog.apply(...)` line in
 * `setOverrides` / `setLanguage` and "the live catalog speaks the override
 * immediately" / "…the new language immediately" must go RED. They do.
 *
 * The rest pins the round trip through the settings store, because the edit
 * surface's whole job is that the words survive a restart.
 */

import type { InMemoryRecords } from '@camstack/types'
import { ncRecordKinds } from '../record-kinds.js'
import { makeNcRecords } from './support/nc-test-deps.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcTextCatalog } from '../text-catalog.js'
import { NcTextCatalogEditor } from '../text-catalog-editor.js'
import { NcTextCatalogStore } from '../text-catalog-store.js'

interface Ctx {
  readonly world: InMemoryRecords
  readonly store: NcTextCatalogStore
  readonly catalog: NcTextCatalog
  readonly editor: NcTextCatalogEditor
}

async function makeCtx(): Promise<Ctx> {
  const world = makeNcRecords()
  const store = new NcTextCatalogStore({
    kind: world.records.kind(ncRecordKinds.texts),
    logger: makeSilentLogger(),
  })
  const catalog = new NcTextCatalog()
  const editor = new NcTextCatalogEditor({ store, catalog, logger: makeSilentLogger() })
  return { world, store, catalog, editor }
}

describe('NcTextCatalogEditor', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await makeCtx()
  })

  describe('view', () => {
    it('a fresh hub reads English, with nothing overridden', async () => {
      const v = await ctx.editor.view()
      expect(v.language).toBe('en')
      expect(v.activeLanguage).toBe('en')
      expect(v.entries.every((e) => e.override === null)).toBe(true)
      expect(v.entries.every((e) => e.source !== 'override')).toBe(true)
    })

    it('serves the SHIPPED catalog — every key the hub can print', async () => {
      const v = await ctx.editor.view()
      expect(v.entries.length).toBeGreaterThan(50)
      expect(v.entries.map((e) => e.key)).toContain('detection.body')
    })

    it('a language may be inspected WITHOUT becoming the hub language', async () => {
      const v = await ctx.editor.view('it')
      expect(v.language).toBe('it')
      expect(v.activeLanguage).toBe('en')
      const body = v.entries.find((e) => e.key === 'detection.body')
      expect(body?.shippedLanguage).toBe('it')
    })
  })

  describe('setLanguage', () => {
    it('persists the choice and reports it as active', async () => {
      const v = await ctx.editor.setLanguage('it')
      expect(v.activeLanguage).toBe('it')
      const reread = new NcTextCatalogStore({
        kind: ctx.world.records.kind(ncRecordKinds.texts),
        logger: makeSilentLogger(),
      })
      await expect(reread.load()).resolves.toMatchObject({ language: 'it' })
    })

    it('the live catalog speaks the new language IMMEDIATELY', async () => {
      expect(ctx.catalog.language).toBe('en')
      await ctx.editor.setLanguage('it')
      expect(ctx.catalog.language).toBe('it')
    })
  })

  describe('setOverrides', () => {
    it('round-trips through the durable store', async () => {
      await ctx.editor.setOverrides('it', { 'detection.body': 'ciao {{camera}}' })
      const reread = new NcTextCatalogStore({
        kind: ctx.world.records.kind(ncRecordKinds.texts),
        logger: makeSilentLogger(),
      })
      await expect(reread.load()).resolves.toMatchObject({
        overrides: { it: { 'detection.body': 'ciao {{camera}}' } },
      })
    })

    it('the returned view reports the override as the winning layer', async () => {
      const v = await ctx.editor.setOverrides('en', { 'detection.body': 'hello {{camera}}' })
      const row = v.entries.find((e) => e.key === 'detection.body')
      expect(row?.override).toBe('hello {{camera}}')
      expect(row?.source).toBe('override')
      expect(row?.effective).toBe('hello {{camera}}')
      // The shipped text stays beside it, so the row can be reset.
      expect(row?.shipped).not.toBe('hello {{camera}}')
    })

    it('the live catalog speaks the override IMMEDIATELY', async () => {
      const before = ctx.catalog.text({ key: 'detection.body', vars: { camera: 'Gate' } })
      await ctx.editor.setOverrides('en', { 'detection.body': 'hello {{camera}}' })
      const after = ctx.catalog.text({ key: 'detection.body', vars: { camera: 'Gate' } })
      expect(after).toBe('hello Gate')
      expect(after).not.toBe(before)
    })

    it('a rule TEMPLATE still outranks the override — layer 1 is untouched', async () => {
      await ctx.editor.setOverrides('en', { 'detection.body': 'hello' })
      expect(ctx.catalog.text({ key: 'detection.body', template: 'from the rule', vars: {} })).toBe(
        'from the rule',
      )
    })

    it('a reset drops back to the shipped text, live', async () => {
      await ctx.editor.setOverrides('en', { 'detection.body': 'hello' })
      const v = await ctx.editor.setOverrides('en', { 'detection.body': null })
      const row = v.entries.find((e) => e.key === 'detection.body')
      expect(row?.override).toBeNull()
      expect(row?.source).toBe('shipped')
      expect(ctx.catalog.text({ key: 'detection.body', vars: { camera: 'Gate' } })).toContain(
        'Gate',
      )
    })

    it('editing one language leaves the other alone', async () => {
      await ctx.editor.setOverrides('en', { 'detection.body': 'hello' })
      await ctx.editor.setOverrides('it', { 'detection.body': 'ciao' })
      const reread = new NcTextCatalogStore({
        kind: ctx.world.records.kind(ncRecordKinds.texts),
        logger: makeSilentLogger(),
      })
      await expect(reread.load()).resolves.toMatchObject({
        overrides: { en: { 'detection.body': 'hello' }, it: { 'detection.body': 'ciao' } },
      })
    })

    it('an override survives a language change', async () => {
      await ctx.editor.setOverrides('it', { 'detection.body': 'ciao' })
      await ctx.editor.setLanguage('it')
      const v = await ctx.editor.view()
      expect(v.activeLanguage).toBe('it')
      expect(v.entries.find((e) => e.key === 'detection.body')?.override).toBe('ciao')
    })

    it('REFUSES a key no locale ships — a dead override would make the table lie', async () => {
      await expect(ctx.editor.setOverrides('en', { 'not.a.key': 'x' })).rejects.toThrow(
        /not\.a\.key/,
      )
      const reread = new NcTextCatalogStore({
        kind: ctx.world.records.kind(ncRecordKinds.texts),
        logger: makeSilentLogger(),
      })
      await expect(reread.load()).resolves.toMatchObject({ overrides: {} })
    })

    it('refuses the whole patch when ONE key is unknown — never half-applied', async () => {
      await expect(
        ctx.editor.setOverrides('en', { 'detection.body': 'hello', 'not.a.key': 'x' }),
      ).rejects.toThrow(/not\.a\.key/)
      expect(ctx.catalog.snapshot.overrides).toEqual({})
    })
  })
})
