/**
 * The round trip is the contract.
 *
 * A visually-authored automation is re-openable ONLY because the recipe travels
 * inside the file the generator emits. If `generate → parse` is not the identity
 * on the recipe, opening a saved automation and pressing Save rewrites it into
 * something the operator never authored — silently, because both halves would
 * still be perfectly valid TypeScript.
 *
 * So these tests generate real blocks with the real generator, rather than
 * hand-writing the literal they are supposed to read. A fixture would pass while
 * the generator changed shape underneath it, which is the failure this repo has
 * paid for before.
 */

import { type AutomationRecipe, generateAutomationBlock, MAX_WHEN_LEAVES } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ejectRecipeFromCode, looksLikeAutomation, parseRecipeFromCode } from '../recipe-from-code'

const MINIMAL: AutomationRecipe = {
  when: { kind: 'manual' },
  actions: [{ kind: 'wait', seconds: 5 }],
}

const RICH: AutomationRecipe = {
  when: {
    kind: 'all',
    children: [
      {
        kind: 'any',
        children: [
          {
            kind: 'device-becomes',
            deviceId: 101,
            cap: 'motion-sensor',
            fieldPath: 'motion.detected',
            becomes: true,
            edge: true,
            forMs: 30_000,
            debounceMs: 1_500,
          },
          { kind: 'device-event', category: 'device.state-changed', deviceId: 102 },
          { kind: 'schedule', cron: '0 30 23 * * *' },
          { kind: 'manual' },
          {
            kind: 'detection',
            subjects: [
              { macro: 'animal', label: { kind: 'sub-class', className: 'dog' } },
              { macro: 'person' },
            ],
            deviceIds: [101],
          },
        ],
      },
      {
        kind: 'any',
        children: [
          {
            kind: 'device-is',
            deviceId: 101,
            cap: 'power-switch',
            fieldPath: 'on',
            operator: 'eq',
            value: true,
          },
          {
            kind: 'device-is',
            deviceId: 102,
            cap: 'thermostat',
            fieldPath: 'temperature',
            operator: 'in',
            value: [18, 19, 20],
          },
        ],
      },
      {
        kind: 'not',
        child: {
          kind: 'expression',
          expr: 'indoor - outdoor > 5',
          bindings: {
            indoor: {
              kind: 'global',
              sourceStableId: 'hik:101',
              cap: 'thermostat',
              fieldPath: 'temperature',
            },
            outdoor: { kind: 'literal', value: 12 },
          },
        },
      },
    ],
  },
  actions: [
    { kind: 'cap', deviceId: 101, cap: 'alarm-panel', method: 'arm', args: { mode: 'away' } },
    { kind: 'wait', seconds: 2 },
    { kind: 'cap', deviceId: { $var: 'deviceId' }, cap: 'siren', method: 'on' },
    { kind: 'code', code: 'ctx.logger.info("hello")\nawait sleep(1)' },
  ],
}

describe('parseRecipeFromCode', () => {
  it('round-trips a minimal recipe through the real generator', () => {
    const code = generateAutomationBlock({ name: 'Minimal', recipe: MINIMAL })
    const parsed = parseRecipeFromCode(code)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.recipe).toEqual(MINIMAL)
  })

  it('round-trips every trigger, container, leaf and action kind', () => {
    const code = generateAutomationBlock({ name: 'Rich', recipe: RICH })
    const parsed = parseRecipeFromCode(code)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.recipe).toEqual(RICH)
  })

  it('keeps the unit the person picked, on a leaf and on a step arg', () => {
    const withUnits: AutomationRecipe = {
      when: {
        kind: 'all',
        children: [
          { kind: 'manual' },
          {
            kind: 'device-is',
            deviceId: 7,
            cap: 'pet-feeder',
            fieldPath: 'bowlFood',
            operator: 'lt',
            value: 0.01,
            unit: 'g',
          },
        ],
      },
      actions: [
        {
          kind: 'cap',
          deviceId: 7,
          cap: 'pet-feeder',
          method: 'feed',
          args: { grams: 100 },
          argUnits: { grams: 'kg' },
        },
      ],
    }
    const code = generateAutomationBlock({ name: 'Units', recipe: withUnits })
    const parsed = parseRecipeFromCode(code)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.recipe).toEqual(withUnits)
  })

  it('survives a value containing UNBALANCED braces, quotes and backslashes', () => {
    // The literal is scanned by counting braces, so a value carrying more `}`
    // than `{` is the case that decides whether strings are tracked. Without
    // tracking the scan closes the object early and what comes back is a
    // valid-looking PREFIX of the real recipe — the worst possible outcome,
    // because it parses.
    //
    // The braces must be UNBALANCED and there must be more of them than the
    // nesting depth at that point; a matched `} … {` pair cancels out and would
    // let a broken scanner pass.
    const tricky: AutomationRecipe = {
      when: { kind: 'manual' },
      actions: [
        {
          kind: 'cap',
          deviceId: 1,
          cap: 'notifier',
          method: 'send',
          args: { text: '}}}}}} "quoted" \\ backslash' },
        },
      ],
    }
    const code = generateAutomationBlock({ name: 'Tricky', recipe: tricky })
    const parsed = parseRecipeFromCode(code)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.recipe).toEqual(tricky)
  })

  it('round-trips a recipe at the leaf budget', () => {
    const children = Array.from({ length: MAX_WHEN_LEAVES - 1 }, (_, i) => ({
      kind: 'device-is' as const,
      deviceId: i + 1,
      cap: 'power-switch',
      fieldPath: 'on',
      operator: 'eq' as const,
      value: true,
    }))
    const full: AutomationRecipe = {
      when: { kind: 'all', children: [{ kind: 'manual' }, ...children] },
      actions: [{ kind: 'wait', seconds: 1 }],
    }
    const parsed = parseRecipeFromCode(generateAutomationBlock({ name: 'Full', recipe: full }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.recipe).toEqual(full)
  })

  it('refuses a block that carries no recipe', () => {
    const parsed = parseRecipeFromCode('export default function block() { return () => {} }')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('no AUTOMATION_RECIPE')
  })

  it('refuses a literal that parses but is not a recipe', () => {
    // Valid JSON, valid TypeScript, and NOT a recipe. Opening this in the editor
    // and saving would rewrite the block into whatever the form managed to show.
    const parsed = parseRecipeFromCode('const AUTOMATION_RECIPE = {"when": "soon"} as const')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('recipe schema')
  })
})

describe('looksLikeAutomation', () => {
  it('is true for a generated block and false for a hand-written one', () => {
    expect(looksLikeAutomation(generateAutomationBlock({ name: 'A', recipe: MINIMAL }))).toBe(true)
    expect(looksLikeAutomation('export default (ctx) => () => {}')).toBe(false)
  })

  it('is not fooled by the name appearing in a comment', () => {
    expect(looksLikeAutomation('// mentions AUTOMATION_RECIPE but declares nothing')).toBe(false)
  })
})

describe('ejectRecipeFromCode', () => {
  it('makes the block stop being an automation', () => {
    const code = generateAutomationBlock({ name: 'Rich', recipe: RICH })
    const ejected = ejectRecipeFromCode(code)

    expect(looksLikeAutomation(ejected)).toBe(false)
    expect(parseRecipeFromCode(ejected).ok).toBe(false)
  })

  it('keeps the rest of the block byte-identical and takes the `as const` with it', () => {
    const code = generateAutomationBlock({ name: 'Rich', recipe: RICH })
    const ejected = ejectRecipeFromCode(code)

    // A dangling `as const` is a syntax error, and the block would then fail the
    // server-side compile on the very save meant to hand it over intact.
    // The recipe's `as const` goes; the block's own (RUN_MODE) stays.
    const asConstCount = (text: string): number => text.split('as const').length - 1
    expect(asConstCount(ejected)).toBe(asConstCount(code) - 1)
    expect(ejected).not.toMatch(/^\}\s*as const/m)
    expect(ejected).toContain('export default function block(ctx: AddonContext)')
    expect(ejected).toContain('EJECTED from the visual automation editor')
  })

  it('is idempotent', () => {
    const once = ejectRecipeFromCode(generateAutomationBlock({ name: 'A', recipe: MINIMAL }))
    expect(ejectRecipeFromCode(once)).toBe(once)
  })

  it('leaves a block that never had a recipe alone', () => {
    const script = 'export default (ctx) => () => {}'
    expect(ejectRecipeFromCode(script)).toBe(script)
  })
})
