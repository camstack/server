/**
 * The three `nc.*` text-catalog bridge actions (i18n Phase 2).
 *
 * They are thin — every decision lives in `NcTextCatalogEditor` — so what is
 * worth pinning here is exactly what a thin layer can still get wrong:
 *
 *  - the CATALOG declares `auth: 'admin'` on all three, the READ included. The
 *    dispatcher enforces it (`cap-providers.ts`), so the contract entry is the
 *    only place this can be lost, and losing it hands every authenticated user
 *    the ability to re-word the household's notifications;
 *  - a node with no centre REFUSES rather than answering an empty catalog. An
 *    empty catalog on the Texts tab reads as "my customisations are gone";
 *  - the round trip actually reaches the store, and the answer is the fresh
 *    view (not the client's optimistic guess).
 */

import { NcRuleAiStore } from '../rule-ai-store.js'
import { ncRecordKinds } from '../record-kinds.js'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import { makeNcActionHandlers, type NcActionHandlers, ncActions } from '../nc-actions.js'
import { NcRuleStore } from '../rule-store.js'
import { NcTextCatalog } from '../text-catalog.js'
import { NcTextCatalogEditor } from '../text-catalog-editor.js'
import { NcTextCatalogStore } from '../text-catalog-store.js'
import { makeNcRecords } from './support/nc-test-deps.js'

const TEXT_ACTIONS = ['nc.getTexts', 'nc.setLanguage', 'nc.setTextOverrides'] as const

interface Ctx {
  readonly handlers: NcActionHandlers
  readonly catalog: NcTextCatalog
  readonly fake: FakeSettingsStore
}

async function makeCtx(opts: { readonly withTexts: boolean } = { withTexts: true }): Promise<Ctx> {
  const fake = makeFakeSettingsStore()
  const world = makeNcRecords()
  const ruleStore = new NcRuleStore({
    kind: world.records.kind(ncRecordKinds.rules),
    logger: makeSilentLogger(),
  })
  const textStore = new NcTextCatalogStore({
    kind: world.records.kind(ncRecordKinds.texts),
    logger: makeSilentLogger(),
  })
  const catalog = new NcTextCatalog()
  const editor = new NcTextCatalogEditor({
    store: textStore,
    catalog,
    logger: makeSilentLogger(),
  })
  const handlers = makeNcActionHandlers({
    ruleStore,
    ruleAiStore: NcRuleAiStore.of(world.records, makeSilentLogger()),
    logger: makeSilentLogger(),
    listCallerTargetIds: async () => [],
    snooze: {
      list: () => [],
      create: async () => {
        throw new Error('not used')
      },
      cancel: async () => {},
    },
    ...(opts.withTexts ? { texts: editor } : {}),
  })
  return { handlers, catalog, fake }
}

describe('nc.* text catalog actions', () => {
  describe('the contract', () => {
    it.each(TEXT_ACTIONS)('%s is admin-only', (name) => {
      expect(ncActions[name].auth).toBe('admin')
    })

    it('the read is a query and the two writes are mutations', () => {
      expect(ncActions['nc.getTexts'].kind).toBe('query')
      expect(ncActions['nc.setLanguage'].kind).toBe('mutation')
      expect(ncActions['nc.setTextOverrides'].kind).toBe('mutation')
    })
  })

  describe('a node with no notification centre', () => {
    let ctx: Ctx
    beforeEach(async () => {
      ctx = await makeCtx({ withTexts: false })
    })

    it('REFUSES the read rather than answering an empty catalog', async () => {
      await expect(ctx.handlers['nc.getTexts']({})).rejects.toThrow(/does not host/)
    })

    it('refuses both writes', async () => {
      await expect(ctx.handlers['nc.setLanguage']({ language: 'it' })).rejects.toThrow(
        /does not host/,
      )
      await expect(
        ctx.handlers['nc.setTextOverrides']({ language: 'it', overrides: {} }),
      ).rejects.toThrow(/does not host/)
    })
  })

  describe('wired to a centre', () => {
    let ctx: Ctx
    beforeEach(async () => {
      ctx = await makeCtx()
    })

    it('serves the shipped catalog, in the hub language', async () => {
      const view = await ctx.handlers['nc.getTexts']({})
      expect(view.language).toBe('en')
      expect(view.activeLanguage).toBe('en')
      expect(view.entries.length).toBeGreaterThan(50)
    })

    it('serves another language WITHOUT switching the hub to it', async () => {
      const view = await ctx.handlers['nc.getTexts']({ language: 'it' })
      expect(view.language).toBe('it')
      expect(view.activeLanguage).toBe('en')
      expect(ctx.catalog.language).toBe('en')
    })

    it('switches the hub language and answers the fresh view', async () => {
      const view = await ctx.handlers['nc.setLanguage']({ language: 'it' })
      expect(view.activeLanguage).toBe('it')
      expect(ctx.catalog.language).toBe('it')
    })

    it('overrides a key, reports the winning layer, and the next read agrees', async () => {
      const written = await ctx.handlers['nc.setTextOverrides']({
        language: 'en',
        overrides: { 'detection.body': 'hello {{camera}}' },
      })
      expect(written.entries.find((e) => e.key === 'detection.body')).toMatchObject({
        override: 'hello {{camera}}',
        source: 'override',
      })
      const reread = await ctx.handlers['nc.getTexts']({})
      expect(reread.entries.find((e) => e.key === 'detection.body')?.override).toBe(
        'hello {{camera}}',
      )
    })

    it('a null resets the key back to the shipped text', async () => {
      await ctx.handlers['nc.setTextOverrides']({
        language: 'en',
        overrides: { 'detection.body': 'hello' },
      })
      const after = await ctx.handlers['nc.setTextOverrides']({
        language: 'en',
        overrides: { 'detection.body': null },
      })
      expect(after.entries.find((e) => e.key === 'detection.body')?.source).toBe('shipped')
    })

    it('refuses a key no locale ships', async () => {
      await expect(
        ctx.handlers['nc.setTextOverrides']({ language: 'en', overrides: { 'nope.nope': 'x' } }),
      ).rejects.toThrow(/nope\.nope/)
    })
  })
})
