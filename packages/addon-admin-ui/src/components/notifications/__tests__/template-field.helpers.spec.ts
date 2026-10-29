import { describe, expect, it } from 'vitest'
import type {
  NcSystemEventKind,
  NcTemplateVarContext,
  NcTemplateVarDescriptor,
} from '@camstack/types'
import {
  isHeldBackTemplateVar,
  NC_TEMPLATE_VARS,
  NcDeliverySchema,
  servedTemplateVars,
  NcRuleKindSchema,
  NcTemplateFamilySchema,
  NcTemplateFieldSchema,
  templateVarsFor,
} from '@camstack/types'
import {
  groupTemplateVars,
  insertPlaceholder,
  placeholderToken,
  restoreHeldBackKinds,
  restoreHeldBackVars,
  templatePlaceholders,
  unknownPlaceholders,
  varsForContext,
} from '../template-field.helpers'

const v = (
  over: Partial<NcTemplateVarDescriptor> & Pick<NcTemplateVarDescriptor, 'name'>,
): NcTemplateVarDescriptor => ({
  label: over.name,
  example: 'x',
  group: 'subject',
  families: ['rule'],
  ...over,
})

describe('insertPlaceholder', () => {
  it('inserts at a collapsed cursor and puts the cursor after the token', () => {
    expect(insertPlaceholder('ab', { start: 1, end: 1 }, '{{camera}}')).toEqual({
      value: 'a{{camera}}b',
      cursor: 11,
    })
  })
  it('replaces a selection', () => {
    expect(insertPlaceholder('hello world', { start: 6, end: 11 }, '{{rule}}')).toEqual({
      value: 'hello {{rule}}',
      cursor: 14,
    })
  })
  it('clamps a stale selection past the end to an append', () => {
    expect(insertPlaceholder('ab', { start: 9, end: 9 }, '{{x}}')).toEqual({
      value: 'ab{{x}}',
      cursor: 7,
    })
  })
})

describe('placeholderToken', () => {
  it('a plain variable is the whole token, cursor after it', () => {
    expect(placeholderToken(v({ name: 'camera' }))).toEqual({
      text: '{{camera}}',
      cursorOffset: 10,
    })
  })
  it('a dynamic prefix leaves the cursor INSIDE, before the braces close', () => {
    expect(
      placeholderToken(v({ name: 'count_', dynamic: { prefix: 'count_', from: 'classes' } })),
    ).toEqual({
      text: '{{count_}}',
      cursorOffset: 8,
    })
  })
})

describe('unknownPlaceholders', () => {
  const known = [
    v({ name: 'camera' }),
    v({ name: 'count_', dynamic: { prefix: 'count_', from: 'classes' } }),
  ]
  it('uses the renderer grammar, spaces included', () => {
    expect(templatePlaceholders('{{ camera }} {{a.b}} {{rule}}')).toEqual(['camera', 'rule'])
  })
  it('names what the hub would print as empty, once each', () => {
    expect(unknownPlaceholders('{{camera}} {{tiles}} {{tiles}} {{count_person}}', known)).toEqual([
      'tiles',
    ])
  })
  it('a bare dynamic prefix is unknown (it needs a class)', () => {
    expect(unknownPlaceholders('{{count_}}', known)).toEqual(['count_'])
  })
})

describe('varsForContext', () => {
  const vars = [
    v({ name: 'camera', families: ['rule', 'timelapse'] }),
    v({ name: 'ai', families: ['rule', 'summary'], fields: ['body'] }),
    v({ name: 'count', families: ['rule'], kinds: ['occupancy'] }),
    v({
      name: 'percentage',
      families: ['rule'],
      kinds: ['system'],
      systemEventKinds: ['device-battery-low'],
    }),
  ]
  it('filters by family, field, kind and system-event kind', () => {
    const names = (ctx: Parameters<typeof varsForContext>[1]) =>
      varsForContext(vars, ctx).map((d) => d.name)
    expect(names({ family: 'rule', field: 'title', kind: 'detection' })).toEqual(['camera'])
    expect(names({ family: 'rule', field: 'body', kind: 'detection' })).toEqual(['camera', 'ai'])
    expect(names({ family: 'rule', field: 'title', kind: 'occupancy' })).toEqual([
      'camera',
      'count',
    ])
    expect(
      names({
        family: 'rule',
        field: 'title',
        kind: 'system',
        systemEventKinds: ['device-battery-low'],
      }),
    ).toEqual(['camera', 'percentage'])
    expect(
      names({
        family: 'rule',
        field: 'title',
        kind: 'system',
        systemEventKinds: ['backup-completed'],
      }),
    ).toEqual(['camera'])
  })
})

describe('varsForContext is the SAME answer as templateVarsFor, exhaustively', () => {
  // Every family × field × (no kind + every kind) × (no delivery + every
  // delivery) × (no system-event kinds + a representative one from each
  // family the catalog actually branches on: a device kind, an update kind,
  // an alarm kind) the schema allows — not just the combinations this file's
  // author thought to hand-pick. `varsForContext` must be provably
  // interchangeable with `templateVarsFor` (constrained: it cannot import
  // `templateVarsFor` itself, a Module-Federation singleton value in the
  // admin addon), so this is the arbiter, not the hand-picked contexts below.
  const families = NcTemplateFamilySchema.options
  const fields = NcTemplateFieldSchema.options
  const kinds: readonly (NcTemplateVarContext['kind'] | undefined)[] = [
    undefined,
    ...NcRuleKindSchema.options,
  ]
  const deliveries: readonly (NcTemplateVarContext['delivery'] | undefined)[] = [
    undefined,
    ...NcDeliverySchema.options,
  ]
  const systemEventKindSets: readonly (readonly NcSystemEventKind[] | undefined)[] = [
    undefined,
    ['device-battery-low'],
    ['addon-update-available'],
    ['alarm-triggered'],
  ]

  it('agrees on every context the schema allows', () => {
    const mismatches: string[] = []
    for (const family of families) {
      for (const field of fields) {
        for (const kind of kinds) {
          for (const delivery of deliveries) {
            for (const systemEventKinds of systemEventKindSets) {
              const ctx: NcTemplateVarContext = {
                family,
                field,
                kind,
                delivery,
                systemEventKinds: systemEventKinds ? [...systemEventKinds] : undefined,
              }
              const local = varsForContext(NC_TEMPLATE_VARS, ctx)
                .map((d) => d.name)
                .sort()
              const shared = templateVarsFor(ctx)
                .map((d) => d.name)
                .sort()
              if (JSON.stringify(local) !== JSON.stringify(shared)) {
                mismatches.push(
                  `${JSON.stringify(ctx)}: local=${JSON.stringify(local)} shared=${JSON.stringify(shared)}`,
                )
              }
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([])
  })
})

describe('groupTemplateVars', () => {
  it('keeps the fixed group order and drops empty groups', () => {
    const groups = groupTemplateVars([
      v({ name: 'rule', group: 'rule' }),
      v({ name: 'camera', group: 'subject' }),
    ])
    expect(groups.map((g) => g.group)).toEqual(['subject', 'rule'])
  })
})

/**
 * D723 / D647: the hub HOLDS BACK some kinds from the served catalog so an
 * installed viewer can still parse it. The admin restores them from its build.
 */
describe('restoreHeldBackKinds', () => {
  const alertRule: NcTemplateVarContext = {
    family: 'rule',
    field: 'body',
    kind: 'system',
    systemEventKinds: ['alert-critical'],
  }

  it('the served catalog alone offers a held-back kind nothing of its own', () => {
    const names = varsForContext(servedTemplateVars(), alertRule).map((d) => d.name)
    expect(names).not.toContain('severity')
  })

  it('restored, it offers the severity variable', () => {
    const names = varsForContext(restoreHeldBackKinds(servedTemplateVars()), alertRule).map(
      (d) => d.name,
    )
    expect(names).toEqual(expect.arrayContaining(['severity', 'rule', 'eventKind']))
  })

  it('restores ONLY held-back kinds, and only where this build declares them', () => {
    const restored = restoreHeldBackKinds(servedTemplateVars())
    // The summary vocabulary is held back WHOLE (D647) — `restoreHeldBackVars`
    // puts it back, not this.
    expect(restored.map((d) => d.systemEventKinds)).toEqual(
      NC_TEMPLATE_VARS.filter((d) => !isHeldBackTemplateVar(d)).map((d) => d.systemEventKinds),
    )
    // A descriptor this build does not know is served through untouched.
    const unknown = v({ name: 'fromANewerHub', systemEventKinds: ['node-offline'] })
    expect(restoreHeldBackKinds([unknown])).toEqual([unknown])
  })
})

describe('restoreHeldBackVars (D647)', () => {
  it('puts back the state-summary vocabulary the hub holds back whole — and nothing twice', () => {
    const restored = restoreHeldBackVars(restoreHeldBackKinds(servedTemplateVars()))
    expect(restored.map((d) => d.name).toSorted()).toEqual(
      NC_TEMPLATE_VARS.map((d) => d.name).toSorted(),
    )
    expect(restoreHeldBackVars(restored)).toHaveLength(restored.length)
  })

  it('a summary rule is offered the summary vars; an instant one is not', () => {
    const catalog = restoreHeldBackVars(restoreHeldBackKinds(servedTemplateVars()))
    const summary = varsForContext(catalog, {
      family: 'rule',
      field: 'body',
      kind: 'device-events',
      systemEventKinds: ['device-battery-low'],
      systemEventDelivery: 'summary',
    }).map((d) => d.name)
    expect(summary).toEqual(expect.arrayContaining(['summaryText', 'summaryBattery', 'rule']))
    expect(summary).not.toContain('deviceName')
    const instant = varsForContext(catalog, {
      family: 'rule',
      field: 'body',
      kind: 'device-events',
      systemEventKinds: ['device-battery-low'],
    }).map((d) => d.name)
    expect(instant).not.toContain('summaryText')
    expect(instant).toContain('deviceName')
  })
})
