/**
 * D920 guard — the cap vocabulary is complete and agrees with the cap
 * definitions. Each case removes one thing from a known-good fake and
 * expects exactly the complaint that names it.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {
  CapabilityDefinition,
  CapabilityMethodAccess,
} from '../../packages/types/src/capabilities/capability-definition.ts'
import { method } from '../../packages/types/src/capabilities/capability-definition.ts'
import type { LooseCapVocabularyEntry } from '../../packages/types/src/device/cap-vocabulary/types.ts'
import { kebabToCamel } from '../../packages/types/src/capabilities/cap-router-predicates.ts'
import { CAP_VOCABULARY_BY_NAME } from '../../packages/types/src/device/cap-vocabulary/vocabulary.ts'
import { ICON_KEYS } from '../../packages/types/src/device/icon-catalog.generated.ts'
import { EventCategory } from '../../packages/types/src/enums/event-category.ts'
import { ALL_CAPABILITY_DEFINITIONS } from '../../packages/types/src/generated/capability-router-map.ts'
import { METHOD_ACCESS_MAP } from '../../packages/types/src/generated/method-access-map.ts'
import { checkCapVocabulary, type CapVocabularyCheckInput } from '../lib/cap-vocabulary-check.ts'

const switchDef = {
  name: 'switch',
  scope: 'device',
  mode: 'singleton',
  methods: {
    setState: method(z.object({ deviceId: z.number(), on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    setLevel: method(
      z.object({ deviceId: z.number(), level: z.number().min(0).max(100) }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
      },
    ),
    setMode: method(z.object({ deviceId: z.number(), mode: z.enum(['eco', 'boost']) }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    configure: method(z.object({ deviceId: z.number(), x: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    listModes: method(z.object({ deviceId: z.number() }), z.array(z.string())),
  },
  events: {
    onPressed: { data: z.object({ deviceId: z.number() }) },
  },
  status: {
    schema: z.object({
      on: z.boolean(),
      level: z.number(),
      mode: z.enum(['eco', 'boost']),
    }),
    kind: 'push',
  },
} satisfies CapabilityDefinition

const backupDef = {
  name: 'backup',
  scope: 'system',
  mode: 'singleton',
  methods: {
    run: method(z.object({}), z.void(), { kind: 'mutation' }),
  },
} satisfies CapabilityDefinition

const L = { en: 'x', it: 'x' }

function goodSwitch(): LooseCapVocabularyEntry {
  return {
    scope: 'device',
    noun: { en: 'Switch', it: 'Interruttore' },
    actions: [
      {
        id: 'switch.on',
        method: 'setState',
        label: { en: 'Turn on', it: 'Accendi' },
        phrase: { en: 'Turn on {device}', it: 'Accendi {device}' },
        icon: 'power',
        args: { on: true },
      },
      {
        id: 'switch.level',
        method: 'setLevel',
        label: L,
        phrase: {
          en: 'Set {device} to {level}',
          it: 'Imposta {device} a {level}',
        },
        icon: 'gauge',
        openArgs: [
          {
            key: 'level',
            label: L,
            offer: { kind: 'number', min: 0, max: 100, unit: '%' },
          },
        ],
      },
      {
        id: 'switch.mode',
        method: 'setMode',
        label: L,
        phrase: {
          en: 'Set {device} to {mode}',
          it: 'Imposta {device} su {mode}',
        },
        icon: 'gauge',
        openArgs: [
          {
            key: 'mode',
            label: L,
            offer: { kind: 'enum', values: [{ value: 'eco', label: L }] },
          },
        ],
      },
    ],
    state: [
      {
        kind: 'boolean',
        field: 'on',
        label: L,
        whenTrue: L,
        whenFalse: L,
        icon: 'power',
      },
      {
        kind: 'numeric',
        field: 'level',
        quantity: L,
        label: L,
        unit: '%',
        icon: 'gauge',
      },
      {
        kind: 'enum',
        field: 'mode',
        label: L,
        values: [{ value: 'eco', label: L }],
        icon: 'gauge',
      },
    ],
    events: {
      onPressed: {
        category: 'doorbell.onPressed',
        label: L,
        phrase: { en: 'When {device} rings', it: 'Quando {device} suona' },
        icon: 'bell',
      },
    },
  }
}

function input(
  vocabulary: Readonly<Record<string, LooseCapVocabularyEntry>>,
): CapVocabularyCheckInput {
  const defs: readonly CapabilityDefinition[] = [switchDef, backupDef]
  return {
    defs,
    vocabulary,
    accessOf: (cap: string, m: string): CapabilityMethodAccess | undefined =>
      m.startsWith('list') ? 'view' : cap.length > 0 ? 'create' : undefined,
    iconKeys: new Set(['power', 'gauge', 'bell']),
    eventCategories: new Set(['doorbell.onPressed']),
  }
}

const BACKUP: LooseCapVocabularyEntry = {
  scope: 'system',
  notOperatorFacing: 'cluster admin',
}

function problemsOf(
  sw: LooseCapVocabularyEntry,
  backup: LooseCapVocabularyEntry = BACKUP,
): readonly string[] {
  return checkCapVocabulary(input({ switch: sw, backup })).problems
}

describe('checkCapVocabulary', () => {
  it('accepts a complete, true vocabulary', () => {
    const result = checkCapVocabulary(input({ switch: goodSwitch(), backup: BACKUP }))
    expect(result.problems).toEqual([])
    expect(result.stats).toMatchObject({
      caps: 2,
      deviceCaps: 1,
      systemCaps: 1,
      actions: 3,
      operateMethods: 3,
    })
  })

  it('refuses a cap with no entry', () => {
    const result = checkCapVocabulary(input({ switch: goodSwitch() }))
    expect(result.problems).toEqual(['backup: cap has no vocabulary entry'])
  })

  it('refuses an operate method with no action and no reason — and accepts the reason', () => {
    const sw = goodSwitch()
    const without = {
      ...sw,
      actions: (sw.actions ?? []).filter((a) => a.method !== 'setMode'),
    }
    expect(problemsOf(without)).toEqual([
      'switch.setMode: an operate method with no action and no notOperatorFacing reason',
    ])
    expect(
      problemsOf({
        ...without,
        notOperatorFacing: { setMode: 'tuning, not an action' },
      }),
    ).toEqual([])
  })

  it('does not demand an action for an admin configuration method or a read', () => {
    const problems = problemsOf(goodSwitch())
    expect(problems.some((p) => p.includes('configure') || p.includes('listModes'))).toBe(false)
  })

  it('refuses an emitted event with no phrase', () => {
    expect(problemsOf({ ...goodSwitch(), events: {} })).toEqual([
      "switch: emitted event 'onPressed' has no phrase and no notOperatorFacing reason",
    ])
  })

  it('refuses a phrase placeholder that no arg fills', () => {
    const sw = goodSwitch()
    const actions = (sw.actions ?? []).map((a) =>
      a.id === 'switch.on'
        ? {
            ...a,
            phrase: {
              en: 'Turn on {device} at {when}',
              it: 'Accendi {device}',
            },
          }
        : a,
    )
    expect(problemsOf({ ...sw, actions })).toEqual([
      "switch action 'switch.on' phrase (en): placeholder {when} has no arg to fill it",
    ])
  })

  it('refuses a label without Italian', () => {
    expect(problemsOf({ ...goodSwitch(), noun: { en: 'Switch', it: '' } })).toEqual([
      "switch.noun: label lacks 'it'",
    ])
  })

  it('refuses an offered value or bound the method input refuses', () => {
    const sw = goodSwitch()
    const actions = (sw.actions ?? []).map((a) => {
      if (a.id === 'switch.mode') {
        return {
          ...a,
          openArgs: [
            {
              key: 'mode',
              label: L,
              offer: {
                kind: 'enum' as const,
                values: [{ value: 'turbo', label: L }],
              },
            },
          ],
        }
      }
      if (a.id === 'switch.level') {
        return {
          ...a,
          openArgs: [
            {
              key: 'level',
              label: L,
              offer: { kind: 'number' as const, min: 0, max: 255 },
            },
          ],
        }
      }
      if (a.id === 'switch.on') return { ...a, args: { on: 'yes' } }
      return a
    })
    expect(problemsOf({ ...sw, actions })).toEqual([
      "switch action 'switch.on': fixed arg 'on' = \"yes\" is refused by the method's input schema",
      "switch action 'switch.level': 'level' offers max 255 above the schema's 100",
      "switch action 'switch.mode': offered value \"turbo\" for 'mode' is refused by the input schema",
    ])
  })

  it('refuses a state trigger whose field kind or values disagree with the status schema', () => {
    const sw = goodSwitch()
    const state = [
      {
        kind: 'boolean' as const,
        field: 'level',
        label: L,
        whenTrue: L,
        whenFalse: L,
        icon: 'power' as const,
      },
      {
        kind: 'enum' as const,
        field: 'mode',
        label: L,
        values: [{ value: 'turbo', label: L }],
        icon: 'gauge' as const,
      },
    ]
    expect(problemsOf({ ...sw, state })).toEqual([
      "switch state 'level': phrased as boolean but the field is number",
      "switch state 'mode': value 'turbo' is not one the field takes",
    ])
  })

  it('refuses a system entry with no reason and a scope that disagrees', () => {
    expect(problemsOf(goodSwitch(), { scope: 'system', notOperatorFacing: '' })).toEqual([
      'backup: a system cap entry must say why it is not operator-facing',
    ])
    expect(problemsOf({ scope: 'system', notOperatorFacing: 'no' })).toEqual([
      "switch: entry scope 'system' but the cap is 'device'",
    ])
  })

  it('refuses a duplicated action id', () => {
    const sw = goodSwitch()
    const first = (sw.actions ?? [])[0]
    if (first === undefined) throw new Error('fixture')
    const actions = [...(sw.actions ?? []), { ...first, icon: 'power' as const }]
    expect(problemsOf({ ...sw, actions })).toEqual([
      "switch action 'switch.on': id already used by switch",
    ])
  })
})

describe('the real cap vocabulary', () => {
  function realInput(
    vocabulary: Readonly<Record<string, LooseCapVocabularyEntry>>,
  ): CapVocabularyCheckInput {
    return {
      defs: ALL_CAPABILITY_DEFINITIONS,
      vocabulary,
      accessOf: (cap, m) => METHOD_ACCESS_MAP[`${kebabToCamel(cap)}.${m}`]?.access,
      iconKeys: new Set<string>(ICON_KEYS),
      eventCategories: new Set<string>(Object.values(EventCategory)),
    }
  }

  it('is complete and agrees with every cap definition', () => {
    const result = checkCapVocabulary(realInput(CAP_VOCABULARY_BY_NAME))
    expect(result.problems).toEqual([])
    expect(result.stats.caps).toBe(ALL_CAPABILITY_DEFINITIONS.length)
  })

  it('fails when a real operate method loses its action', () => {
    const ptz = CAP_VOCABULARY_BY_NAME['ptz']
    if (ptz === undefined) throw new Error('ptz entry missing')
    const withoutPreset = {
      ...CAP_VOCABULARY_BY_NAME,
      ptz: {
        ...ptz,
        actions: (ptz.actions ?? []).filter((a) => a.method !== 'goToPreset'),
      },
    }
    expect(checkCapVocabulary(realInput(withoutPreset)).problems).toEqual([
      'ptz.goToPreset: an operate method with no action and no notOperatorFacing reason',
    ])
  })

  it('fails when a real cap loses its entry', () => {
    const { switch: _dropped, ...rest } = CAP_VOCABULARY_BY_NAME
    void _dropped
    expect(checkCapVocabulary(realInput(rest)).problems).toEqual([
      'switch: cap has no vocabulary entry',
    ])
  })
})
