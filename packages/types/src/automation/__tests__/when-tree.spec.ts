/**
 * The single `when` tree: the author-time refusal (rule 3), the one-way read
 * conversion of a stored `{ triggers, conditions }` recipe, the step args in the
 * trace, and the macro-class-plus-label subject model.
 */
import { describe, expect, it } from 'vitest'
import { CLASS_MAP_MACRO_TARGETS } from '../../types/labels.js'
import {
  AutomationRecipeSchema,
  AutomationRunTraceSchema,
  AutomationStepTraceSchema,
  buildStepArgsTrace,
  DETECTION_LABEL_SOURCES,
  DetectionSubjectSchema,
  MAX_TRACE_ARG_LENGTH,
  REDACTED_ARG,
  StationarySubjectSchema,
  subClassesOf,
  validateRecipeBounds,
  type AutomationRecipe,
  type AutomationWhen,
} from '../index.js'

const SIREN = { kind: 'cap', deviceId: 1, cap: 'siren', method: 'on' } as const
const light = {
  kind: 'device-becomes',
  deviceId: 5,
  cap: 'switch',
  fieldPath: 'on',
  becomes: true,
} as const
const motion = { kind: 'device-event', category: 'motion.on-motion-changed' } as const
const detect: AutomationWhen = {
  kind: 'detection',
  deviceIds: [7],
  subjects: [{ macro: 'person' }],
}
const door = {
  kind: 'device-is',
  deviceId: 3,
  cap: 'contact',
  fieldPath: 'open',
  operator: 'eq',
  value: true,
} as const

const recipe = (when: AutomationWhen): AutomationRecipe => ({ when, actions: [SIREN] })

describe('rule 3: two events that can only be satisfied together are refused, with the reason', () => {
  it('all of two events', () => {
    const msg = validateRecipeBounds(recipe({ kind: 'all', children: [light, detect] }))
    expect(msg).toContain('same instant')
    expect(msg).toContain('Use "any of"')
  })

  it('an event under a not', () => {
    expect(validateRecipeBounds(recipe({ kind: 'not', child: light }))).toContain('did not happen')
  })

  it('the equivalent shapes after normalisation: not(any(A,B)) and all(not A, not B)', () => {
    const viaAny = recipe({ kind: 'not', child: { kind: 'any', children: [light, motion] } })
    const viaAll = recipe({
      kind: 'all',
      children: [
        { kind: 'not', child: light },
        { kind: 'not', child: motion },
      ],
    })
    expect(validateRecipeBounds(viaAny)).toContain('did not happen')
    expect(validateRecipeBounds(viaAll)).toContain('did not happen')
  })

  it('an all of two events hidden inside an any is refused only in that branch', () => {
    const msg = validateRecipeBounds(
      recipe({ kind: 'all', children: [{ kind: 'any', children: [light, motion] }, detect] }),
    )
    expect(msg).toContain('same instant')
  })

  it('legal shapes pass: any of events, event + states, states only, not over a state', () => {
    expect(
      validateRecipeBounds(recipe({ kind: 'any', children: [light, motion, detect] })),
    ).toBeNull()
    expect(validateRecipeBounds(recipe({ kind: 'all', children: [light, door] }))).toBeNull()
    expect(
      validateRecipeBounds(
        recipe({ kind: 'all', children: [{ kind: 'any', children: [light, motion] }, door] }),
      ),
    ).toBeNull()
    expect(validateRecipeBounds(recipe(door))).toBeNull()
    expect(
      validateRecipeBounds(
        recipe({ kind: 'all', children: [light, { kind: 'not', child: door }] }),
      ),
    ).toBeNull()
  })
})

describe('read-time conversion of a stored { triggers, conditions } recipe', () => {
  const parse = (input: object): AutomationRecipe => AutomationRecipeSchema.parse(input)
  const oldCondition = {
    kind: 'condition',
    deviceId: 3,
    cap: 'contact',
    fieldPath: 'open',
    operator: 'eq',
    value: true,
  }

  it('a single trigger and no condition is not wrapped', () => {
    expect(parse({ triggers: [{ kind: 'manual' }], actions: [SIREN] }).when).toEqual({
      kind: 'manual',
    })
  })

  it('several triggers become any(...)', () => {
    expect(
      parse({ triggers: [{ kind: 'manual' }, { kind: 'interval', minutes: 5 }], actions: [SIREN] })
        .when,
    ).toEqual({ kind: 'any', children: [{ kind: 'manual' }, { kind: 'interval', minutes: 5 }] })
  })

  it('triggers + conditions become all(any(triggers), C), and the old "condition" becomes "is"', () => {
    expect(
      parse({
        triggers: [{ kind: 'manual' }, { kind: 'interval', minutes: 5 }],
        conditions: oldCondition,
        actions: [SIREN],
      }).when,
    ).toEqual({
      kind: 'all',
      children: [
        { kind: 'any', children: [{ kind: 'manual' }, { kind: 'interval', minutes: 5 }] },
        door,
      ],
    })
  })

  it('a single trigger with a condition is all(trigger, C)', () => {
    expect(
      parse({ triggers: [{ kind: 'manual' }], conditions: oldCondition, actions: [SIREN] }).when,
    ).toEqual({ kind: 'all', children: [{ kind: 'manual' }, door] })
  })

  it('the new shape passes through untouched, and a converted recipe is a legal tree', () => {
    const fresh = recipe({ kind: 'all', children: [light, door] })
    expect(parse(fresh)).toEqual(fresh)
    const converted = parse({
      triggers: [{ kind: 'detection', classes: ['dog'], deviceIds: [7] }, { kind: 'manual' }],
      conditions: oldCondition,
      actions: [SIREN],
    })
    expect(validateRecipeBounds(converted)).toBeNull()
  })

  it('a stored raw class becomes its macro plus a label: dog → animal / dog', () => {
    const converted = parse({
      triggers: [{ kind: 'detection', classes: ['dog', 'person', 'forklift'], deviceIds: [7] }],
      actions: [SIREN],
    })
    expect(converted.when).toMatchObject({
      kind: 'detection',
      subjects: [
        { macro: 'animal', label: { kind: 'sub-class', className: 'dog' } },
        { macro: 'person' },
        { macro: 'other', className: 'forklift' },
      ],
    })
  })

  it('the equivalence that matters: "light becomes on while door open" is not "door opens while light on"', () => {
    const a = recipe({ kind: 'all', children: [light, door] })
    const b = recipe({
      kind: 'all',
      children: [
        { ...light, deviceId: 3, cap: 'contact', fieldPath: 'open' },
        { ...door, deviceId: 5, cap: 'switch', fieldPath: 'on' },
      ],
    })
    expect(parse(a)).not.toEqual(parse(b))
    expect(validateRecipeBounds(a)).toBeNull()
    expect(validateRecipeBounds(b)).toBeNull()
  })
})

describe('the step args in the trace', () => {
  it('an old step trace with no args still parses, and a new one carries them', () => {
    const old = { path: 'actions.0', kind: 'cap', outcome: 'ok' }
    expect(AutomationStepTraceSchema.safeParse(old).success).toBe(true)
    expect(
      AutomationStepTraceSchema.safeParse({ ...old, args: { level: 3, mode: 'night' } }).success,
    ).toBe(true)
  })

  it('an old run trace with a "conditions.0" / kind "condition" node still parses', () => {
    const oldTrace = {
      runId: 'r',
      startedAt: 1,
      endedAt: 1,
      trigger: { kind: 'interval', outcome: 'pass', reason: 'fired', vars: {} },
      conditions: [{ path: 'conditions.0', kind: 'condition', outcome: 'fail', reason: 'x' }],
      steps: [],
      outcome: 'skipped-conditions',
      repeat: 1,
      lastAt: 1,
    }
    expect(AutomationRunTraceSchema.safeParse(oldTrace).success).toBe(true)
  })

  it('redacts a secret by name and by keychain marker, and bounds the rest', () => {
    const args = buildStepArgsTrace({
      level: 3,
      password: 'hunter2',
      note: 'x'.repeat(MAX_TRACE_ARG_LENGTH + 50),
      blob: { a: 1 },
      handle: { $secret: 'system/token' },
    })
    expect(args['level']).toBe(3)
    expect(args['password']).toBe(REDACTED_ARG)
    expect(args['handle']).toBe(REDACTED_ARG)
    expect(String(args['note']).length).toBe(MAX_TRACE_ARG_LENGTH + 1)
    expect(args['blob']).toBe('{"a":1}')
    expect(JSON.stringify(args)).not.toContain('hunter2')
  })
})

describe('a detection subject is ONE macro class plus an optional label', () => {
  it('the macros it offers are the taxonomy’s own macro targets, no second list', () => {
    expect(Object.keys(DETECTION_LABEL_SOURCES).sort()).toEqual([...CLASS_MAP_MACRO_TARGETS].sort())
    for (const macro of CLASS_MAP_MACRO_TARGETS) {
      expect(DetectionSubjectSchema.safeParse({ macro }).success).toBe(true)
    }
  })

  it('a sub-class label must belong to its macro in the taxonomy', () => {
    expect(subClassesOf('animal')).toContain('dog')
    const ok = { macro: 'animal', label: { kind: 'sub-class', className: 'dog' } }
    const wrong = { macro: 'animal', label: { kind: 'sub-class', className: 'car' } }
    expect(DetectionSubjectSchema.safeParse(ok).success).toBe(true)
    expect(DetectionSubjectSchema.safeParse(wrong).success).toBe(false)
  })

  it('a person carries a face, a vehicle a plate; an animal neither', () => {
    const face = { macro: 'person', label: { kind: 'identity', identityId: 'i1', name: 'Ann' } }
    const plate = { macro: 'vehicle', label: { kind: 'plate', text: 'AB123CD' } }
    expect(DetectionSubjectSchema.safeParse(face).success).toBe(true)
    expect(DetectionSubjectSchema.safeParse(plate).success).toBe(true)
    expect(DetectionSubjectSchema.safeParse({ macro: 'animal', label: face.label }).success).toBe(
      false,
    )
  })

  it('a parked object refuses a face or plate label — its event carries neither', () => {
    const plate = { macro: 'vehicle', label: { kind: 'plate', text: 'AB123CD' } }
    expect(StationarySubjectSchema.safeParse(plate).success).toBe(false)
    expect(
      StationarySubjectSchema.safeParse({
        macro: 'vehicle',
        label: { kind: 'sub-class', className: 'truck' },
      }).success,
    ).toBe(true)
  })

  it('the editor lists labels per macro through the galleries’ own caps', () => {
    expect(DETECTION_LABEL_SOURCES.person).toEqual([
      { kind: 'cap', cap: 'face-gallery', method: 'listIdentities', label: 'identity' },
    ])
    expect(DETECTION_LABEL_SOURCES.vehicle).toContainEqual({
      kind: 'cap',
      cap: 'plate-gallery',
      method: 'listPlates',
      label: 'plate',
    })
  })
})
