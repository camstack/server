/**
 * Unit tests for the pure Notification Rules form helpers (slices D1 + D2).
 */
import type { NcConditionDescriptor, NcDelivery, NcRule, NcSystemEventKind } from '@camstack/types'
import {
  audioIsFailClosed,
  NC_ALARM_SYSTEM_EVENT_KINDS,
  NC_AUDIO_DB_OFFERED,
  NC_AUDIO_DEFAULTS,
  NC_CONDITION_CATALOG,
  ruleKindSpec,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NC_OCCUPANCY_DEFAULTS } from '../notification-condition-fields'
import {
  buildConditions,
  buildRuleClears,
  buildRuleInput,
  changeRuleDelivery,
  changeSystemEventFamily,
  cooldownLabel,
  DEFAULT_NC_RULE_TAB,
  defaultDeliveryForSection,
  deliveryLabel,
  emptyRuleForm,
  isConditionValueEmpty,
  isRecognisedDelivery,
  isRuleEditable,
  isRuleFormValid,
  isRuleSnoozeExempt,
  isSystemSectionKey,
  NC_COOLDOWN_MAX_SEC,
  NC_DEFAULT_COOLDOWN_SEC,
  NC_DELIVERY_OPTIONS,
  NC_LINKED_CAMERA_OPTIONS,
  NC_IMAGE_OPTIONS,
  NC_RULE_SECTIONS,
  NC_RULE_TABS,
  type NcRuleFormState,
  type NcRuleSectionSubject,
  parseCooldown,
  parseDelivery,
  parseLinkedCameras,
  parseMediaImage,
  parseRuleSection,
  parseRuleTab,
  ruleFormProblems,
  ruleMatchesSection,
  rulePreservedFields,
  ruleSeedForSection,
  ruleTabsFor,
  ruleToForm,
  visibleRuleSections,
  withLocalConditionDescriptors,
} from '../notification-rules.helpers'
import { ruleScopeDraftOf, switchRuleScopeMode } from '../rule-scope-model'

const CATALOG: readonly NcConditionDescriptor[] = NC_CONDITION_CATALOG

function sampleRule(overrides: Partial<NcRule> = {}): NcRule {
  return {
    id: 'r1',
    name: 'Front door',
    enabled: true,
    disabledTargetIds: [],
    delivery: 'track-end',
    conditions: { classes: ['person'] },
    schedule: { windows: [{ days: [1], startMinute: 480, endMinute: 1020 }] },
    targets: [{ targetId: 't1' }, { targetId: 't2', params: { sound: 'ping' } }],
    media: { attach: 'keyFrame' },
    throttle: { cooldownSec: 120, scope: 'rule' },
    template: { title: 'Hi', body: 'Body' },
    priority: 4,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('deliveryLabel', () => {
  it('maps each trigger to prose', () => {
    expect(deliveryLabel('immediate')).toBe('Immediate')
    expect(deliveryLabel('track-end')).toBe('Track end')
    expect(deliveryLabel('device-event')).toBe('Device event')
    expect(deliveryLabel('package-event')).toBe('Package event')
  })
})

describe('parseDelivery / parseMediaImage', () => {
  it('narrows known values and rejects unknown ones (no cast)', () => {
    expect(parseDelivery('track-end')).toBe('track-end')
    expect(parseDelivery('bogus')).toBeUndefined()
    expect(parseMediaImage('scene-boxes')).toBe('scene-boxes')
    expect(parseMediaImage('crop')).toBe('crop')
    // The retired attach modes are not picture modes.
    expect(parseMediaImage('best-matching')).toBeUndefined()
  })

  it('offers the four picture modes, each with a description line (D897)', () => {
    expect(NC_IMAGE_OPTIONS.map((o) => o.value)).toEqual(['scene-boxes', 'crop', 'clean', 'none'])
    for (const option of NC_IMAGE_OPTIONS) {
      expect(option.description.length).toBeGreaterThan(0)
    }
  })
})

describe('emptyRuleForm', () => {
  it('seeds a blank, non-savable form with empty conditions', () => {
    const form = emptyRuleForm()
    expect(form.name).toBe('')
    expect(form.enabled).toBe(true)
    expect(form.delivery).toBe('immediate')
    expect(form.targetIds).toEqual([])
    expect(form.targetParams).toEqual({})
    expect(form.conditions).toEqual({})
    expect(form.schedule).toBeUndefined()
    expect(isRuleFormValid(form)).toBe(false)
  })
})

describe('isRuleFormValid', () => {
  it('requires a name and at least one target', () => {
    const base = { ...emptyRuleForm(), name: 'x', targetIds: ['t1'] }
    expect(isRuleFormValid(base)).toBe(true)
    expect(isRuleFormValid({ ...base, name: '   ' })).toBe(false)
    expect(isRuleFormValid({ ...base, targetIds: [] })).toBe(false)
  })
})

describe('the global-snooze grant round-trips', () => {
  it('writes the flag ONLY when granted, so an ungranted rule carries no field', () => {
    const form = { ...emptyRuleForm(), name: 'x', targetIds: ['t1'] }
    expect(buildRuleInput(form).snoozeAllowGlobal).toBeUndefined()
    expect(buildRuleInput({ ...form, snoozeAllowGlobal: true }).snoozeAllowGlobal).toBe(true)
  })

  it('survives an edit — the grant is not lost by opening and saving the rule', () => {
    // This is the field that decides who may silence other people. A form that
    // dropped it on a round-trip would revoke it silently on the next save.
    const rule = sampleRule({ snoozeAllowGlobal: true })
    expect(buildRuleInput(ruleToForm(rule)).snoozeAllowGlobal).toBe(true)
  })
})

describe('"Ask me to confirm detections" round-trips (#243)', () => {
  const form = { ...emptyRuleForm('immediate'), name: 'x', targetIds: ['t1'] }

  it('writes nothing until the operator touches it', () => {
    expect(buildRuleInput(form).askVerdict).toBeUndefined()
  })

  it('writes an explicit true, and an explicit false to switch a stored true off', () => {
    expect(buildRuleInput({ ...form, askVerdict: true }).askVerdict).toBe(true)
    expect(buildRuleInput({ ...form, askVerdict: false }).askVerdict).toBe(false)
  })

  it('survives an edit', () => {
    expect(buildRuleInput(ruleToForm(sampleRule({ askVerdict: true }))).askVerdict).toBe(true)
  })

  it('never reaches the hub from a rule that reports no track', () => {
    const system = { ...emptyRuleForm('system-event'), name: 'x', targetIds: ['t1'] }
    expect(buildRuleInput({ ...system, askVerdict: true }).askVerdict).toBeUndefined()
  })
})

describe('the throttle survives a save', () => {
  it('carries `granularity` through an edit', () => {
    // It did NOT: `buildRuleInput` rebuilt the throttle from `cooldownSec` and
    // `scope` and simply never copied the third field, so every admin save
    // reverted a `per-class` rule to `shared` — one window for everything the
    // rule matches, which is the "a cat mutes the next dog" behaviour the
    // field exists to remove. Nothing said so: the editor did not show the
    // granularity then (it does since D654), so the loss was invisible.
    const rule = sampleRule({
      throttle: { cooldownSec: 120, scope: 'rule', granularity: 'per-class' },
    })
    const input = buildRuleInput(ruleToForm(rule), undefined, CATALOG)
    expect(input.throttle).toEqual({ cooldownSec: 120, scope: 'rule', granularity: 'per-class' })
  })

  it('OMITS the key when the rule has none — absent reads as `per-class` since 2026-10-01 (D36)', () => {
    const rule = sampleRule()
    const input = buildRuleInput(ruleToForm(rule), undefined, CATALOG)
    expect('granularity' in input.throttle).toBe(false)
  })
})

describe('the snooze durations a rule offers', () => {
  it('omits the key when the operator never said — the hub applies its defaults', () => {
    const form = { ...emptyRuleForm(), name: 'x', targetIds: ['t1'] }
    expect(buildRuleInput(form).snoozeOptions).toBeUndefined()
  })

  it('EMITS an empty list rather than omitting it', () => {
    // `[]` is "no snooze buttons on this rule". Omitting it would hand the
    // rule back the defaults on the very next save, which is the opposite of
    // what the operator asked for — and the same shape of loss the media
    // policy already paid for once.
    const form = { ...emptyRuleForm(), name: 'x', targetIds: ['t1'], snoozeOptions: [] }
    expect(buildRuleInput(form).snoozeOptions).toEqual([])
  })

  it('round-trips a chosen list through an edit', () => {
    const rule = sampleRule({ snoozeOptions: [5, 60] })
    expect(buildRuleInput(ruleToForm(rule)).snoozeOptions).toEqual([5, 60])
  })

  it('round-trips an EMPTY list through an edit', () => {
    const rule = sampleRule({ snoozeOptions: [] })
    expect(buildRuleInput(ruleToForm(rule)).snoozeOptions).toEqual([])
  })
})

describe('which rules a snooze can never silence', () => {
  it('exempts a rule ABOUT the panel', () => {
    expect(isRuleSnoozeExempt({ systemEvent: { kinds: ['alarm-triggered'] } }, [])).toBe(true)
  })

  it('exempts EVERY alarm kind the hub exempts — parity with the server list', () => {
    // The local mirror held four; a rule on `alarm-arm-refused` read as
    // snoozeable here while the hub refused to snooze it.
    for (const kind of NC_ALARM_SYSTEM_EVENT_KINDS) {
      expect(isRuleSnoozeExempt({ systemEvent: { kinds: [kind] } }, []), kind).toBe(true)
    }
  })

  it('exempts a rule that ACTUATES the panel (including button-only steps)', () => {
    expect(
      isRuleSnoozeExempt({}, [{ kind: 'cap', deviceId: 900, cap: 'alarm-panel', method: 'arm' }]),
    ).toBe(true)
  })

  it('CONTROL — an ordinary rule is snoozeable', () => {
    expect(isRuleSnoozeExempt({ classes: ['person'] }, [])).toBe(false)
    expect(isRuleSnoozeExempt({ systemEvent: { kinds: ['device-offline'] } }, [])).toBe(false)
    expect(
      isRuleSnoozeExempt({}, [{ kind: 'cap', deviceId: 12, cap: 'switch', method: 'turnOn' }]),
    ).toBe(false)
  })
})

describe('ruleToForm', () => {
  it('hydrates every editable field including conditions, schedule, target params', () => {
    const form = ruleToForm(sampleRule())
    expect(form.name).toBe('Front door')
    expect(form.delivery).toBe('track-end')
    expect(form.targetIds).toEqual(['t1', 't2'])
    expect(form.priority).toBe(4)
    // A pre-D897 `attach: 'keyFrame'` rule reads as the clean scene.
    expect(form.mediaImage).toBe('clean')
    expect(form.templateTitle).toBe('Hi')
    expect(form.templateBody).toBe('Body')
    // The class list is the class SCOPE (D641), lifted out of `conditions`.
    expect(form.conditions).toEqual({})
    expect(form.classScope).toMatchObject({ mode: 'only', include: ['person'] })
    expect(form.schedule).toEqual({ windows: [{ days: [1], startMinute: 480, endMinute: 1020 }] })
    // Only the target that carries params is captured.
    expect(form.targetParams).toEqual({ t2: { sound: 'ping' } })
  })

  it('reads the global-snooze grant as OFF unless the rule says otherwise', () => {
    // Absent is not "unknown" here — it is the default, and the default is the
    // safe one: nobody but an admin may silence this rule for other people.
    expect(ruleToForm(sampleRule()).snoozeAllowGlobal).toBe(false)
    expect(ruleToForm(sampleRule({ snoozeAllowGlobal: true })).snoozeAllowGlobal).toBe(true)
  })

  it('tolerates an absent template', () => {
    const form = ruleToForm(sampleRule({ template: undefined }))
    expect(form.templateTitle).toBe('')
    expect(form.templateBody).toBe('')
  })
})

describe('isConditionValueEmpty', () => {
  it('treats unset / empty as empty, and touched values as set', () => {
    expect(isConditionValueEmpty('classes', undefined)).toBe(true)
    expect(isConditionValueEmpty('classes', [])).toBe(true)
    expect(isConditionValueEmpty('classes', ['x'])).toBe(false)
    expect(isConditionValueEmpty('source', 'pipeline')).toBe(false)
    expect(isConditionValueEmpty('minConfidence', 0)).toBe(false)
    expect(isConditionValueEmpty('minConfidence', 0.5)).toBe(false)
    expect(isConditionValueEmpty('zones', { ids: [] })).toBe(true)
    expect(isConditionValueEmpty('zones', { ids: ['z1'], match: 'any' })).toBe(false)
    expect(isConditionValueEmpty('plates', { values: [] })).toBe(true)
    expect(isConditionValueEmpty('plates', { values: ['AB1'], maxDistance: 1 })).toBe(false)
  })

  it("reads 'any' per key, because it does not mean the same thing twice", () => {
    // `source: 'any'` matches every source — identical to absent, so omit it.
    expect(isConditionValueEmpty('source', 'any')).toBe(true)
    // `crossing: 'any'` INCLUDES exits, while absent excludes them. Omitting it
    // would save "entered or left" as "entering" and quietly drop every exit
    // the operator asked for.
    expect(isConditionValueEmpty('crossing', 'any')).toBe(false)
  })
})

describe('buildConditions', () => {
  it('omits untouched keys and keeps authored ones (author-vs-omit)', () => {
    const built = buildConditions(
      { classes: ['person'], classesExclude: [], minConfidence: 0.6, source: 'any' },
      'immediate',
      CATALOG,
    )
    expect(built).toEqual({ classes: ['person'], minConfidence: 0.6 })
  })

  it('drops conditions that do not apply to the current trigger', () => {
    // minImportance / minDwellSeconds are track-end only; on an immediate rule
    // they must be stripped rather than authored fail-closed.
    const built = buildConditions(
      { classes: ['car'], minImportance: 0.8, minDwellSeconds: 5 },
      'immediate',
      CATALOG,
    )
    expect(built).toEqual({ classes: ['car'] })
  })

  it('keeps track-end-only conditions on a track-end rule', () => {
    const built = buildConditions({ minImportance: 0.8 }, 'track-end', CATALOG)
    expect(built).toEqual({ minImportance: 0.8 })
  })

  it("keeps crossing 'any' while still dropping source 'any'", () => {
    // Both are the string 'any' and they mean opposite things: for `source` it
    // is "no restriction" (= absent), for `crossing` it is the ONLY value that
    // lets an exit through, where absent excludes exits. A value-only
    // emptiness rule strips both and silently turns "entered or left" into
    // "entering".
    const built = buildConditions({ crossing: 'any', source: 'any' }, 'immediate', CATALOG)
    expect(built).toEqual({ crossing: 'any' })
  })

  it('keeps an explicit exit, and omits an absent crossing', () => {
    expect(buildConditions({ crossing: 'exit' }, 'immediate', CATALOG)).toEqual({
      crossing: 'exit',
    })
    expect(buildConditions({}, 'immediate', CATALOG)).toEqual({})
  })

  it('drops crossing on a track-end rule, which cannot evaluate one', () => {
    // The descriptor is `appliesTo: ['immediate']` — a closed track carries no
    // crossing, so authoring it here would be a fail-closed rule.
    const built = buildConditions({ classes: ['car'], crossing: 'exit' }, 'track-end', CATALOG)
    expect(built).toEqual({ classes: ['car'] })
  })
})

describe('buildRuleInput', () => {
  it('assembles a create input with empty conditions and default throttle', () => {
    const input = buildRuleInput(
      {
        ...emptyRuleForm(),
        name: '  Porch  ',
        enabled: false,
        delivery: 'device-event',
        targetIds: ['a', 'b'],
        priority: 2,
        mediaImage: 'none',
      },
      undefined,
      CATALOG,
    )
    expect(input.name).toBe('Porch')
    expect(input.enabled).toBe(false)
    expect(input.delivery).toBe('device-event')
    expect(input.conditions).toEqual({})
    expect(input.targets).toEqual([{ targetId: 'a' }, { targetId: 'b' }])
    expect(input.media).toEqual({ image: 'none' })
    expect(input.throttle).toEqual({
      cooldownSec: NC_DEFAULT_COOLDOWN_SEC,
      scope: 'rule-device',
    })
    expect(input.priority).toBe(2)
    expect(input.template).toBeUndefined()
    expect(input.schedule).toBeUndefined()
  })

  it('emits a partial template when only one field is set', () => {
    const input = buildRuleInput(
      { ...emptyRuleForm(), name: 'x', targetIds: ['t'], templateTitle: 'Only title' },
      undefined,
      CATALOG,
    )
    expect(input.template).toEqual({ title: 'Only title' })
  })

  it('preserves per-target params across an edit (L2)', () => {
    const form: NcRuleFormState = {
      ...ruleToForm(sampleRule()),
    }
    const input = buildRuleInput(form, undefined, CATALOG)
    expect(input.targets).toEqual([
      { targetId: 't1' },
      { targetId: 't2', params: { sound: 'ping' } },
    ])
  })

  it('preserves throttle and authored conditions/schedule on edit', () => {
    const rule = sampleRule()
    const input = buildRuleInput(ruleToForm(rule), undefined, CATALOG)
    // classes applies to track-end → preserved.
    expect(input.conditions).toEqual({ classes: ['person'] })
    expect(input.schedule).toEqual(rule.schedule)
    expect(input.throttle).toEqual({ cooldownSec: 120, scope: 'rule' })
  })

  it('omits an empty schedule (no windows)', () => {
    const input = buildRuleInput(
      { ...emptyRuleForm(), name: 'x', targetIds: ['t'], schedule: { windows: [] } },
      undefined,
      CATALOG,
    )
    expect(input.schedule).toBeUndefined()
  })
})

describe('the editor tabs', () => {
  it('opens on the common case', () => {
    expect(DEFAULT_NC_RULE_TAB).toBe('rule')
    expect(NC_RULE_TABS[0].key).toBe('rule')
  })

  it('orders them common → advanced, which is the whole point of splitting them', () => {
    // `actions` sits before `advanced`: what a rule DOES is not an advanced
    // setting, and it was authorable only through the cap until 2026-08-05.
    // `devices` sits right after `rule`: which cameras/sensors a rule watches
    // is the second thing an author decides, and it stopped being one
    // condition among many when it grew a filter over 293 devices.
    expect(NC_RULE_TABS.map((tab) => tab.key)).toEqual([
      'rule',
      'devices',
      'conditions',
      'notification',
      'actions',
      'advanced',
    ])
  })

  it('claims EVERY form field exactly once — an unclaimed field is uneditable, silently', () => {
    // The failure this guards: tabs make it easy to add a field to the form
    // state and forget to render it anywhere. The rule still round-trips it, so
    // nothing breaks and nothing says so — the operator simply cannot change it.
    const claimed = NC_RULE_TABS.flatMap((tab) => tab.fields)
    const all = Object.keys(emptyRuleForm()).toSorted()
    expect(claimed.toSorted()).toEqual(all)
    expect(new Set(claimed).size).toBe(claimed.length)
  })

  it('parses a tab key and ignores an unknown one', () => {
    expect(parseRuleTab('conditions')).toBe('conditions')
    expect(parseRuleTab('nope')).toBeUndefined()
  })
})

describe('devices moved to their own tab and must still round-trip', () => {
  it('hydrates the device scope from conditions.devices', () => {
    const form = ruleToForm(
      sampleRule({ conditions: { classes: ['person'], devices: [101, 102] } }),
    )
    expect(form.deviceScope).toMatchObject({ mode: 'only', include: [101, 102] })
  })

  it('folds the device scope back into conditions.devices on save', () => {
    const form = {
      ...emptyRuleForm(),
      name: 'x',
      targetIds: ['t'],
      deviceScope: ruleScopeDraftOf<number>([101], undefined),
    }
    expect(buildRuleInput(form, undefined, CATALOG).conditions.devices).toEqual([101])
  })

  it('OMITS devices when nothing is selected — empty means every device', () => {
    // An emitted `devices: []` is a condition that matches nothing, which is
    // the exact inverse of what an empty selection means.
    const form = {
      ...emptyRuleForm(),
      name: 'x',
      targetIds: ['t'],
      deviceScope: switchRuleScopeMode(ruleScopeDraftOf<number>([], undefined), 'only'),
    }
    expect(buildRuleInput(form, undefined, CATALOG).conditions.devices).toBeUndefined()
  })

  it('survives an open-and-save with no edits', () => {
    // The failure the viewer's media-policy mirror already caused once: a field
    // the form forgot is a field the next save destroys.
    const rule = sampleRule({ conditions: { classes: ['person'], devices: [101, 102] } })
    expect(buildRuleInput(ruleToForm(rule), rule, CATALOG).conditions.devices).toEqual([101, 102])
  })
})

// ── Sustained sound (2026-08-13) ────────────────────────────────────

/**
 * The shape of the LIVE audio rule (id 4d7dbe2a…, "Pianto o urla nelle camere
 * da letto" [Crying or screaming in the bedrooms]), authored from the phone before this editor could render it.
 * Opening it in the admin UI and saving it must produce the same rule.
 */
function liveAudioRule(): NcRule {
  return sampleRule({
    id: '4d7dbe2a',
    name: 'Pianto o urla nelle bedrooms',
    delivery: 'immediate',
    conditions: {
      devices: [108, 107],
      audio: { labels: ['crying', 'scream'], hitPercent: 60, samplingSeconds: 10 },
    },
    schedule: undefined,
    template: undefined,
  })
}

describe('an audio rule survives the admin editor', () => {
  it('round-trips open→save with no edits', () => {
    const rule = liveAudioRule()
    const input = buildRuleInput(ruleToForm(rule), rule, CATALOG)
    expect(input.conditions).toEqual(rule.conditions)
  })

  it('keeps a threshold-only condition — dbThreshold 0 and no labels is authored', () => {
    // `0` is full scale, a legitimate (if extreme) authored threshold, and a
    // value-only emptiness rule would have pruned it.
    const rule = sampleRule({
      delivery: 'immediate',
      conditions: { audio: { dbThreshold: 0, hitPercent: 60, samplingSeconds: 10 } },
      schedule: undefined,
    })
    expect(buildRuleInput(ruleToForm(rule), rule, CATALOG).conditions.audio).toEqual(
      rule.conditions.audio,
    )
  })

  it('drops it when the trigger moves off immediate — the engine never evaluates it there', () => {
    const form = { ...ruleToForm(liveAudioRule()), delivery: 'track-end' as NcDelivery }
    expect(buildRuleInput(form, undefined, CATALOG).conditions.audio).toBeUndefined()
  })

  it('PRESERVES it against a hub whose catalog predates the descriptor', () => {
    // The failure this closes is the one the viewer already paid for: an
    // editor that prunes to the SERVED catalog silently strips a condition the
    // running hub understands but has not yet advertised, so opening the live
    // rule and saving it would erase the sound it matches on. The local
    // descriptor list is the fallback — the same "absent means use your own
    // list" rule the served `options` follow.
    const rule = liveAudioRule()
    const olderHub = CATALOG.filter((d) => d.id !== 'audio')
    const catalog = withLocalConditionDescriptors(olderHub)
    expect(catalog.some((d) => d.id === 'audio')).toBe(true)
    expect(buildRuleInput(ruleToForm(rule), rule, catalog).conditions).toEqual(rule.conditions)
  })

  it('adds nothing when the hub serves no catalog at all', () => {
    // An empty catalog means "not answered yet", and the editor already says
    // so. Injecting one lone condition there would render an editor offering
    // sound and nothing else.
    expect(withLocalConditionDescriptors([])).toEqual([])
  })

  it('never shadows the served descriptor — the hub wins where it answers', () => {
    const merged = withLocalConditionDescriptors(CATALOG)
    expect(merged.filter((d) => d.id === 'audio')).toHaveLength(1)
    expect(merged.find((d) => d.id === 'audio')).toBe(CATALOG.find((d) => d.id === 'audio'))
  })
})

// ── System events (2026-08-12) ──────────────────────────────────────

describe('the trigger this build cannot author', () => {
  it('offers system-event, so opening a live system rule no longer rewrites it', () => {
    // The defect this closes: the trigger `<Select>` is controlled by
    // `form.delivery` and had no `system-event` option, so it rendered the
    // FIRST option ("Immediate") and the next interaction saved the rule as a
    // detection rule. One live rule ("Eventi di sistema") was one click away
    // from being destroyed by its own editor.
    expect(NC_DELIVERY_OPTIONS.map((o) => o.value)).toContain('system-event')
    expect(parseDelivery('system-event')).toBe('system-event')
    expect(deliveryLabel('system-event')).toBe('System event')
  })

  it('recognises every trigger it renders an option for, and nothing else', () => {
    for (const option of NC_DELIVERY_OPTIONS) {
      expect(isRecognisedDelivery(option.value)).toBe(true)
    }
    expect(isRecognisedDelivery('quantum-event')).toBe(false)
  })

  it('refuses to SAVE an unrecognised trigger rather than coercing it', () => {
    // Belt and braces behind the read-only dialog: even if a form somehow
    // carried a trigger this build cannot render, the save button stays
    // disabled instead of writing whatever the select happens to show.
    const valid = { ...emptyRuleForm(), name: 'x', targetIds: ['t1'] }
    expect(isRuleFormValid(valid)).toBe(true)
    // DOCUMENTED TYPE BOUNDARY: the case under test is a hub NEWER than this
    // bundle, i.e. a delivery string the local enum cannot express. There is no
    // way to stage it without stepping outside the enum, and staging it is the
    // whole point — this is the failure that shipped.
    const unknown: NcRuleFormState = { ...valid, delivery: 'quantum-event' as NcDelivery }
    expect(isRuleFormValid(unknown)).toBe(false)
  })

  it('blocks a system rule that selects no event (the hub rejects kinds: [])', () => {
    const base = { ...emptyRuleForm('system-event'), name: 'x', targetIds: ['t1'] }
    expect(isRuleFormValid(base)).toBe(false)
    expect(
      isRuleFormValid({ ...base, conditions: { systemEvent: { kinds: ['node-offline'] } } }),
    ).toBe(true)
  })
})

describe('the list sections', () => {
  it('keeps All as a real section — a rule is never invisible', () => {
    expect(NC_RULE_SECTIONS[0].key).toBe('all')
    expect(ruleMatchesSection({ delivery: 'system-event', conditions: {} }, 'all')).toBe(true)
    expect(ruleMatchesSection({ delivery: 'immediate', conditions: {} }, 'all')).toBe(true)
    // Including a trigger this build has never heard of.
    expect(ruleMatchesSection({ delivery: 'quantum-event', conditions: {} }, 'all')).toBe(true)
  })

  it('routes system rules to their own section and everything else to detections', () => {
    const nodeRule = {
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['node-offline'] } },
    }
    expect(ruleMatchesSection(nodeRule, 'system')).toBe(true)
    expect(ruleMatchesSection(nodeRule, 'detection')).toBe(false)
    // D637: a system rule with no family (no kinds) is a `mixed` rule to recreate.
    expect(ruleMatchesSection({ delivery: 'system-event', conditions: {} }, 'mixed')).toBe(true)
    expect(ruleMatchesSection({ delivery: 'system-event', conditions: {} }, 'detection')).toBe(
      false,
    )
    // `device-event` with no occupancy condition is now its OWN section,
    // `sensor` (operator ruling, 2026-10-01) — a doorbell press used to fall
    // into `detection` for want of its own section.
    for (const delivery of ['immediate', 'track-end', 'package-event']) {
      expect(ruleMatchesSection({ delivery, conditions: {} }, 'detection')).toBe(true)
      expect(ruleMatchesSection({ delivery, conditions: {} }, 'system')).toBe(false)
    }
    expect(ruleMatchesSection({ delivery: 'device-event', conditions: {} }, 'detection')).toBe(
      false,
    )
    expect(ruleMatchesSection({ delivery: 'device-event', conditions: {} }, 'sensor')).toBe(true)
    // An unknown trigger stays VISIBLE in a section rather than vanishing.
    expect(ruleMatchesSection({ delivery: 'quantum-event', conditions: {} }, 'detection')).toBe(
      true,
    )
  })

  it('routes a rule by its CONDITION where the trigger cannot tell them apart', () => {
    // Audio and occupancy are not triggers — they ride `immediate` and
    // `device-event`. The condition is the discriminator, exactly as the engine
    // reads it, so the section strip has to ask the same question.
    const audio = {
      delivery: 'immediate',
      conditions: { audio: { hitPercent: 60, samplingSeconds: 10, dbThreshold: -30 } },
    }
    const occupancy = {
      delivery: 'device-event',
      conditions: { occupancy: { op: 'became-occupied' as const, count: 1, sustainSeconds: 15 } },
    }
    expect(ruleMatchesSection(audio, 'audio')).toBe(true)
    expect(ruleMatchesSection(audio, 'detection')).toBe(false)
    expect(ruleMatchesSection(audio, 'all')).toBe(true)
    expect(ruleMatchesSection(occupancy, 'occupancy')).toBe(true)
    expect(ruleMatchesSection(occupancy, 'detection')).toBe(false)
    expect(ruleMatchesSection(occupancy, 'all')).toBe(true)
    // And a plain rule is in neither.
    const plain = { delivery: 'immediate', conditions: { classes: ['person'] } }
    expect(ruleMatchesSection(plain, 'audio')).toBe(false)
    expect(ruleMatchesSection(plain, 'occupancy')).toBe(false)
  })

  it('partitions the list — every rule lands in exactly one section besides All', () => {
    const samples: readonly NcRuleSectionSubject[] = [
      { delivery: 'immediate', conditions: {} },
      { delivery: 'track-end', conditions: { classes: ['person'] } },
      { delivery: 'system-event', conditions: { systemEvent: { kinds: ['node-offline'] } } },
      { delivery: 'immediate', conditions: { audio: { hitPercent: 60, samplingSeconds: 10 } } },
      {
        delivery: 'device-event',
        conditions: { occupancy: { op: 'became-occupied' as const, count: 1, sustainSeconds: 15 } },
      },
      { delivery: 'quantum-event', conditions: {} },
    ]
    for (const sample of samples) {
      const hits = NC_RULE_SECTIONS.filter(
        (s) => s.key !== 'all' && ruleMatchesSection(sample, s.key),
      )
      expect(hits.length).toBe(1)
      expect(ruleMatchesSection(sample, 'all')).toBe(true)
    }
  })

  it('seeds a new rule with the section it was started from', () => {
    expect(defaultDeliveryForSection('system')).toBe('system-event')
    expect(defaultDeliveryForSection('detection')).toBe('immediate')
    expect(defaultDeliveryForSection('all')).toBe('immediate')
    expect(defaultDeliveryForSection('audio')).toBe('immediate')
    expect(defaultDeliveryForSection('occupancy')).toBe('device-event')
    expect(emptyRuleForm('system-event').delivery).toBe('system-event')
    expect(emptyRuleForm().delivery).toBe('immediate')
  })

  it('narrows a section key and ignores an unknown one', () => {
    expect(parseRuleSection('system')).toBe('system')
    expect(parseRuleSection('audio')).toBe('audio')
    expect(parseRuleSection('occupancy')).toBe('occupancy')
    expect(parseRuleSection('nope')).toBeUndefined()
  })

  it('gives every section its own new-rule label and empty hint', () => {
    for (const section of NC_RULE_SECTIONS) {
      expect(section.newRuleLabel.length).toBeGreaterThan(0)
      expect(section.emptyHint.length).toBeGreaterThan(0)
    }
    // Distinct, or the button says the same thing in five places and the
    // operator learns nothing from switching section. Only a section that
    // HAS the button counts: `mixed` creates nothing (D637).
    const creatable = NC_RULE_SECTIONS.filter((s) => s.creatable)
    expect(new Set(creatable.map((s) => s.newRuleLabel)).size).toBe(creatable.length)
  })
})

describe('the creation presets', () => {
  it('seeds an AUDIO rule that can actually fire', () => {
    const seed = ruleSeedForSection('audio')
    expect(seed.delivery).toBe('immediate')
    const audio = seed.conditions.audio
    expect(audio).toBeDefined()
    // The condition is the discriminator: without it the rule is an ordinary
    // detection rule and never sees a sampling window.
    expect(audio?.hitPercent).toBe(NC_AUDIO_DEFAULTS.hitPercent)
    expect(audio?.samplingSeconds).toBe(NC_AUDIO_DEFAULTS.samplingSeconds)
    // A level floor, so the preset is never the fail-closed shape the engine
    // refuses (neither sound nor level = every sample is a hit).
    expect(audio?.dbThreshold).toBe(NC_AUDIO_DB_OFFERED)
    expect(audioIsFailClosed(audio)).toBe(false)
  })

  it('seeds an OCCUPANCY rule on the trigger its edges ride', () => {
    const seed = ruleSeedForSection('occupancy')
    expect(seed.delivery).toBe('device-event')
    expect(seed.conditions.occupancy).toEqual(NC_OCCUPANCY_DEFAULTS)
  })

  it('seeds a detection rule with the pipeline source and nothing else (R5, D690)', () => {
    const seeded = { delivery: 'immediate', conditions: { source: 'pipeline' } }
    expect(ruleSeedForSection('all')).toEqual(seeded)
    expect(ruleSeedForSection('detection')).toEqual(seeded)
  })

  it('seeds a system-family section WITH its kinds — the family is derived from them (D637)', () => {
    expect(ruleSeedForSection('system')).toEqual({
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['node-offline', 'node-online'] } },
    })
  })

  it('round-trips a seeded audio rule through the form and the builder', () => {
    const seed = ruleSeedForSection('audio')
    const form: NcRuleFormState = {
      ...emptyRuleForm(seed.delivery, seed.conditions),
      name: 'Cane che abbaia',
      targetIds: ['t1'],
    }
    expect(isRuleFormValid(form)).toBe(true)
    const input = buildRuleInput(form, undefined, CATALOG)
    expect(input.delivery).toBe('immediate')
    expect(input.conditions.audio).toEqual(seed.conditions.audio)
    // And back into a form again, unchanged.
    const stored: NcRule = {
      ...sampleRule(),
      delivery: input.delivery,
      conditions: input.conditions,
      media: input.media,
      throttle: input.throttle,
    }
    const back = ruleToForm(stored)
    expect(back.conditions.audio).toEqual(seed.conditions.audio)
    expect(back.delivery).toBe('immediate')
  })

  it('round-trips a seeded occupancy rule through the form and the builder', () => {
    const seed = ruleSeedForSection('occupancy')
    const form: NcRuleFormState = {
      ...emptyRuleForm(seed.delivery, seed.conditions),
      name: 'Pat è tornato',
      targetIds: ['t1'],
      deviceScope: ruleScopeDraftOf<number>([102], undefined),
    }
    expect(isRuleFormValid(form)).toBe(true)
    const input = buildRuleInput(form, undefined, CATALOG)
    expect(input.delivery).toBe('device-event')
    expect(input.conditions.occupancy).toEqual(NC_OCCUPANCY_DEFAULTS)
    expect(input.conditions.devices).toEqual([102])
  })

  it('refuses to save the audio rule the engine would never match', () => {
    // Neither a sound nor a level: every sample is a hit, so the engine
    // returns false rather than notifying on silence (`matchesAudio`).
    const form: NcRuleFormState = {
      ...emptyRuleForm('immediate', { audio: { hitPercent: 60, samplingSeconds: 10 } }),
      name: 'Suono',
      targetIds: ['t1'],
    }
    expect(ruleFormProblems(form).length).toBe(1)
    expect(isRuleFormValid(form)).toBe(false)
    // Naming a sound is enough — a label rule needs no threshold.
    const withLabel: NcRuleFormState = {
      ...form,
      conditions: { audio: { hitPercent: 60, samplingSeconds: 10, labels: ['dog'] } },
    }
    expect(ruleFormProblems(withLabel)).toEqual([])
    expect(isRuleFormValid(withLabel)).toBe(true)
  })

  it('does not invent problems for a rule that has none', () => {
    expect(ruleFormProblems({ ...emptyRuleForm(), name: 'x', targetIds: ['t1'] })).toEqual([])
  })
})

describe('the delivery-aware tabs', () => {
  it('gives a system rule every tab except the one its trigger cannot use', () => {
    const system = ruleTabsFor('system-event').map((t) => t.key)
    const detection = ruleTabsFor('immediate').map((t) => t.key)
    expect(detection).toEqual(NC_RULE_TABS.map((t) => t.key))
    expect(system).toEqual(detection.filter((k) => k !== 'devices'))
  })

  it('drops EXACTLY the fields the trigger cannot author — nothing else', () => {
    // The tab-coverage guard above proves no field is unclaimed. This proves
    // the system subset gives up only `deviceScope`, which `buildRuleInput`
    // refuses to write for this trigger anyway — any other missing field would
    // be uneditable on system rules, silently.
    const claimed = new Set(ruleTabsFor('system-event').flatMap((t) => t.fields))
    const dropped = Object.keys(emptyRuleForm()).filter((key) => !claimed.has(key as never))
    expect(dropped).toEqual(['deviceScope'])
  })

  it('renames the conditions tab for a trigger whose only condition IS the events', () => {
    const tabLabel = (kinds: readonly NcSystemEventKind[]): string | undefined =>
      ruleTabsFor('system-event', { systemEvent: { kinds: [...kinds] } }).find(
        (t) => t.key === 'conditions',
      )?.label
    expect(tabLabel(['node-offline'])).toBe('System events')
    expect(tabLabel(['device-offline'])).toBe('Device events')
    expect(tabLabel(['alarm-triggered'])).toBe('Alarm')
    expect(ruleTabsFor('immediate').find((t) => t.key === 'conditions')?.label).toBe('Conditions')
  })

  it('an alarm rule carries no media picker — its kind names why in mediaBlurb', () => {
    const spec = ruleKindSpec('alarm')
    expect(spec.carriesMedia).toBe(false)
    expect(spec.mediaBlurb).toMatch(/THAT rule's pictures/i)
    expect(
      ruleTabsFor('system-event', { systemEvent: { kinds: ['alarm-triggered'] } }).map(
        (t) => t.key,
      ),
    ).not.toContain('devices')
  })
})

describe('a system rule builds a system-shaped input', () => {
  const systemForm = (): NcRuleFormState => ({
    ...emptyRuleForm('system-event'),
    name: 'Eventi di sistema',
    targetIds: ['t1'],
    conditions: { systemEvent: { kinds: ['device-offline', 'node-offline'] } },
  })

  it('keeps the systemEvent condition intact', () => {
    const input = buildRuleInput(systemForm(), undefined, CATALOG)
    expect(input.delivery).toBe('system-event')
    expect(input.conditions.systemEvent).toEqual({
      kinds: ['device-offline', 'node-offline'],
    })
  })

  it('never writes conditions.devices — the trigger does not evaluate it', () => {
    // The Devices tab is hidden for this trigger, so a `devices` key written
    // here would be a filter the operator cannot see and the engine ignores.
    const scoped = ruleScopeDraftOf<number>([101], undefined)
    const input = buildRuleInput({ ...systemForm(), deviceScope: scoped }, undefined, CATALOG)
    expect(input.conditions.devices).toBeUndefined()
    // …and the same form on a detection trigger still writes it.
    const detection = buildRuleInput(
      { ...systemForm(), delivery: 'immediate', deviceScope: scoped },
      undefined,
      CATALOG,
    )
    expect(detection.conditions.devices).toEqual([101])
  })

  it('attaches no media — there is no frame behind "a node went offline"', () => {
    const input = buildRuleInput({ ...systemForm(), mediaImage: 'crop' }, undefined, CATALOG)
    // Same value the viewer writes for this trigger, so the two editors cannot
    // fight over one rule.
    expect(input.media).toEqual({ image: 'none' })
  })

  it('round-trips the live rule shape without changing it', () => {
    // The shape of the live "Eventi di sistema" rule (id 091937f1…), read from
    // the hub: opening it and saving it must produce the same rule.
    const live = sampleRule({
      delivery: 'system-event',
      conditions: {
        systemEvent: {
          kinds: [
            'device-offline',
            'device-online',
            'node-offline',
            'node-online',
            'addon-update-available',
            'server-update-available',
          ],
        },
      },
      schedule: undefined,
      media: { attach: 'none' },
      throttle: { cooldownSec: 600, scope: 'rule-device' },
      template: undefined,
      targets: [{ targetId: 'zentik-1784924941052' }],
      priority: 3,
    })
    const input = buildRuleInput(ruleToForm(live), live, CATALOG)
    expect(input.delivery).toBe('system-event')
    expect(input.conditions).toEqual(live.conditions)
    expect(input.media).toEqual({ image: 'none' })
    expect(input.throttle).toEqual({ cooldownSec: 600, scope: 'rule-device' })
    expect(input.targets).toEqual([{ targetId: 'zentik-1784924941052' }])
    expect(input.priority).toBe(3)
  })
})

describe('D637 — a system rule is saved and authored as ONE family', () => {
  const alarmForm = (kinds: readonly NcSystemEventKind[]): NcRuleFormState => ({
    ...emptyRuleForm('system-event'),
    name: 'Allarme',
    targetIds: ['t1'],
    conditions: { systemEvent: { kinds: [...kinds], deviceIds: [102] } },
  })

  it('an alarm rule saved without alarm-triggered loses its camera filter', () => {
    const input = buildRuleInput(alarmForm(['alarm-armed']), undefined, CATALOG)
    expect(input.conditions.systemEvent).toEqual({ kinds: ['alarm-armed'] })
  })

  it('an alarm rule with alarm-triggered keeps it', () => {
    const input = buildRuleInput(alarmForm(['alarm-triggered']), undefined, CATALOG)
    expect(input.conditions.systemEvent).toEqual({ kinds: ['alarm-triggered'], deviceIds: [102] })
  })

  it('switching the trigger to system-event seeds a family — never an empty, mixed rule', () => {
    const detection = { ...emptyRuleForm('immediate'), name: 'x', targetIds: ['t1'] }
    const switched = changeRuleDelivery(detection, 'system-event')
    expect(switched.delivery).toBe('system-event')
    expect(switched.conditions.systemEvent?.kinds.length).toBeGreaterThan(0)
    expect(ruleSeedForSection('device-events').conditions.systemEvent).toEqual(
      switched.conditions.systemEvent,
    )
    expect(isRuleFormValid(switched)).toBe(true)
  })

  it('switching to system-event keeps kinds the rule already names', () => {
    const form = {
      ...emptyRuleForm('immediate'),
      conditions: { systemEvent: { kinds: ['node-offline' as const] } },
    }
    expect(changeRuleDelivery(form, 'system-event').conditions.systemEvent).toEqual({
      kinds: ['node-offline'],
    })
  })

  it('switching to any other trigger changes only the trigger', () => {
    const form = emptyRuleForm('immediate')
    expect(changeRuleDelivery(form, 'track-end')).toEqual({ ...form, delivery: 'track-end' })
  })

  it('picking a family reseeds the kinds (and drops the old family’s filters)', () => {
    const form = alarmForm(['alarm-triggered'])
    const next = changeSystemEventFamily(form, 'system')
    expect(next.conditions.systemEvent).toEqual(ruleSeedForSection('system').conditions.systemEvent)
    // Picking the family it already is changes nothing.
    expect(changeSystemEventFamily(form, 'alarm')).toBe(form)
  })

  it('a mixed system rule cannot be saved — the hub refuses it on create', () => {
    const mixed = {
      ...emptyRuleForm('system-event'),
      name: 'x',
      targetIds: ['t1'],
      conditions: { systemEvent: { kinds: ['device-offline' as const, 'node-offline' as const] } },
    }
    expect(isRuleFormValid(mixed)).toBe(false)
  })

  it('an empty-kinds system rule cannot be saved', () => {
    const empty = {
      ...emptyRuleForm('system-event'),
      name: 'x',
      targetIds: ['t1'],
      conditions: { systemEvent: { kinds: [] } },
    }
    expect(isRuleFormValid(empty)).toBe(false)
  })
})

describe('the cooldown is authored, not merely preserved', () => {
  it('hydrates from the rule and writes what the form says', () => {
    expect(ruleToForm(sampleRule()).cooldownSec).toBe(120)
    const input = buildRuleInput(
      { ...ruleToForm(sampleRule()), cooldownSec: 600 },
      sampleRule(),
      CATALOG,
    )
    // The interval is authored; the SCOPE comes from the form, hydrated.
    expect(input.throttle).toEqual({ cooldownSec: 600, scope: 'rule' })
  })

  it('defaults a new rule to the store default', () => {
    expect(emptyRuleForm().cooldownSec).toBe(NC_DEFAULT_COOLDOWN_SEC)
    expect(buildRuleInput({ ...emptyRuleForm(), name: 'x', targetIds: ['t'] }).throttle).toEqual({
      cooldownSec: NC_DEFAULT_COOLDOWN_SEC,
      scope: 'rule-device',
    })
  })

  it('accepts ANY whole number of seconds the hub accepts — 5, 10 and 15 included', () => {
    // The operator's report: the select offered 0/30/60/300/600/1800/3600 and
    // nothing shorter than 30 s, so the three intervals he actually wanted
    // could only be authored through the API. The hub has always taken
    // `int().min(0).max(86_400)`; the picker was the only thing narrowing it.
    for (const seconds of [5, 10, 15]) {
      expect(parseCooldown(String(seconds))).toBe(seconds)
      expect(
        buildRuleInput({ ...emptyRuleForm(), name: 'x', targetIds: ['t'], cooldownSec: seconds })
          .throttle,
      ).toEqual({ cooldownSec: seconds, scope: 'rule-device' })
    }
  })

  it('says a cooldown in words, including one it has no phrase for', () => {
    expect(cooldownLabel(0)).toBe('No cooldown')
    expect(cooldownLabel(600)).toBe('10 minutes')
    expect(cooldownLabel(137)).toBe('137 seconds')
    expect(cooldownLabel(7200)).toBe('2 hours')
    expect(cooldownLabel(5)).toBe('5 seconds')
  })

  it('ignores a stray input value rather than writing it', () => {
    expect(parseCooldown('600')).toBe(600)
    // NOT zero: `Number('')` is 0, and "No cooldown" is a real setting that an
    // empty change event must never author. The operator clears the box to
    // retype, and a box that authors 0 mid-keystroke silences the throttle.
    expect(parseCooldown('')).toBeUndefined()
    expect(parseCooldown('nope')).toBeUndefined()
    expect(parseCooldown('-1')).toBeUndefined()
    // A free-text number box can produce a fraction; the hub's schema is
    // `.int()`, so it is truncated here rather than refused by the server.
    expect(parseCooldown('12.7')).toBe(12)
  })

  it('BLOCKS a cooldown the hub would refuse instead of shipping a Zod string', () => {
    // The other half of removing the select: an input has no option list to
    // bound it, so the bound has to be stated. `86_400` is
    // `NcThrottleSchema.cooldownSec.max`, mirrored.
    expect(ruleFormProblems({ ...emptyRuleForm(), cooldownSec: NC_COOLDOWN_MAX_SEC })).toEqual([])
    const tooLong = ruleFormProblems({ ...emptyRuleForm(), cooldownSec: NC_COOLDOWN_MAX_SEC + 1 })
    expect(tooLong.join(' ')).toContain('86400')
    expect(
      isRuleFormValid({ ...emptyRuleForm(), name: 'x', targetIds: ['t'], cooldownSec: -5 }),
    ).toBe(false)
  })
})

describe('buildRuleClears — what an edit empties', () => {
  it('names every authored field left empty', () => {
    const form = { ...emptyRuleForm('immediate'), templateTitle: ' ', templateBody: '' }
    expect(buildRuleClears(form, []).sort()).toEqual(
      [
        'actions',
        'schedule',
        'snoozeAllowGlobal',
        'snoozeOptions',
        'targetUsers',
        'template',
        'groupingSec',
      ].sort(),
    )
  })

  it('names nothing that the form fills', () => {
    const form = {
      ...emptyRuleForm('immediate'),
      templateTitle: 'T',
      targetUsers: ['u1'],
      snoozeAllowGlobal: true,
      snoozeOptions: [15],
    }
    const clears = buildRuleClears(form, [])
    expect(clears).not.toContain('template')
    expect(clears).not.toContain('targetUsers')
    expect(clears).not.toContain('snoozeAllowGlobal')
    expect(clears).not.toContain('snoozeOptions')
  })

  it('never clears what the admin editor does not author', () => {
    const clears = buildRuleClears(emptyRuleForm('immediate'), [])
    expect(clears).not.toContain('confirm')
    expect(clears).not.toContain('groupIdleSec')
  })

  it('is disjoint from the input it accompanies (the store refuses overlap)', () => {
    const form = { ...emptyRuleForm('immediate'), templateBody: 'B' }
    const input = buildRuleInput(form, undefined, [])
    for (const key of buildRuleClears(form, [])) expect(input[key]).toBeUndefined()
  })
})

describe('Duplicate carries the fields the form does not author', () => {
  it('buildRuleInput re-emits the preserved confirm — and the form carries the full throttle', () => {
    // The throttle is AUTHORED now (D654): a duplicate seeds the form with
    // `ruleToForm(rule)`, so scope + granularity ride on the form, not on the
    // preserved fields.
    const source = sampleRule({
      throttle: { cooldownSec: 30, scope: 'rule', granularity: 'per-class' },
    })
    const preserve = {
      // `enabled`/`timeoutMs`/`onTimeout`/`maxImagePx` carry `.default()` in
      // NcConfirmSchema, so the z.infer OUTPUT type (`NcConfirm`) requires all
      // four: a preserved `confirm` is the parsed rule's, never a partial one.
      confirm: {
        enabled: true,
        prompt: 'is it a person?',
        timeoutMs: 8_000,
        onTimeout: 'fire' as const,
        maxImagePx: 448,
      },
    }
    const input = buildRuleInput(ruleToForm(source), preserve, [])
    expect(input.confirm).toEqual(preserve.confirm)
    expect(input.throttle.scope).toBe('rule')
    expect(input.throttle.granularity).toBe('per-class')
  })
})

describe('media.linkedCameras in the admin editor (ADR 0632)', () => {
  it('round-trips each and leaves an untouched rule without the key', () => {
    const rule = sampleRule({
      delivery: 'device-event',
      media: { attach: 'best', linkedCameras: 'each' },
    })
    expect(ruleToForm(rule).mediaLinkedCameras).toBe('each')
    expect(
      buildRuleInput(ruleToForm(rule), rulePreservedFields(rule), CATALOG).media.linkedCameras,
    ).toBe('each')
    const plain = sampleRule({ delivery: 'device-event', media: { attach: 'best' } })
    expect(
      buildRuleInput(ruleToForm(plain), rulePreservedFields(plain), CATALOG).media,
    ).not.toHaveProperty('linkedCameras')
  })

  it('is never written for a rule that is not about a sensor', () => {
    const form = { ...emptyRuleForm('immediate'), mediaLinkedCameras: 'each' as const }
    expect(buildRuleInput(form, undefined, []).media).not.toHaveProperty('linkedCameras')
  })

  it('the form is the authority now: back to the default clears a stored each', () => {
    const rule = sampleRule({
      delivery: 'device-event',
      media: { attach: 'best', linkedCameras: 'each' },
    })
    const form = { ...ruleToForm(rule), mediaLinkedCameras: undefined }
    expect(buildRuleInput(form, rulePreservedFields(rule), CATALOG).media).not.toHaveProperty(
      'linkedCameras',
    )
  })

  it('a sensor rule with no media writes none of it', () => {
    const form = {
      ...emptyRuleForm('device-event'),
      mediaImage: 'none' as const,
      mediaLinkedCameras: 'each' as const,
    }
    expect(buildRuleInput(form, undefined, []).media).not.toHaveProperty('linkedCameras')
  })

  it('options: the empty value is the default, and parse maps it to absent', () => {
    expect(NC_LINKED_CAMERA_OPTIONS.map((o) => o.value)).toEqual(['', 'mosaic', 'each'])
    expect(parseLinkedCameras('')).toBeUndefined()
    expect(parseLinkedCameras('each')).toBe('each')
    expect(parseLinkedCameras('bogus')).toBeUndefined()
  })

  it('lives on the Notification tab', () => {
    const tab = NC_RULE_TABS.find((t) => t.key === 'notification')
    expect(tab?.fields).toContain('mediaLinkedCameras')
  })
})

describe('clip pre/post-roll survive an admin save (final review I5 follow-up)', () => {
  // The viewer authors the clip window, this editor does not, and the hub
  // replaces `media` whole.
  it('an edit carries both through buildRuleInput while footage is cut', () => {
    const rule = sampleRule({
      media: { attach: 'best', clip: true, clipPreRollSec: 5, clipPostRollSec: 8 },
    })
    const input = buildRuleInput(ruleToForm(rule), rulePreservedFields(rule), CATALOG)
    expect(input.media.clipPreRollSec).toBe(5)
    expect(input.media.clipPostRollSec).toBe(8)
  })

  it('a Duplicate keeps them too', () => {
    const rule = sampleRule({ media: { attach: 'best', gif: true, clipPreRollSec: 0 } })
    const input = buildRuleInput(
      { ...ruleToForm(rule), name: 'copy' },
      rulePreservedFields(rule),
      CATALOG,
    )
    expect(input.media.clipPreRollSec).toBe(0)
  })

  it('dropped once the admin turns clip and gif off — no footage, no roll (as the viewer)', () => {
    const rule = sampleRule({
      media: { attach: 'best', clip: true, clipPreRollSec: 5, clipPostRollSec: 8 },
    })
    const input = buildRuleInput(
      { ...ruleToForm(rule), mediaClip: false },
      rulePreservedFields(rule),
      CATALOG,
    )
    expect(input.media).not.toHaveProperty('clipPreRollSec')
    expect(input.media).not.toHaveProperty('clipPostRollSec')
  })
})

describe('D637 — family sections in the admin list', () => {
  it('lists Devices, System and Alarm beside the camera sections, with admin wording', () => {
    expect(NC_RULE_SECTIONS.map((s) => s.key)).toEqual([
      'all',
      'detection',
      'sensor',
      'audio',
      'occupancy',
      'device-events',
      'system',
      'alarm',
      'mixed',
    ])
    // The admin's own wording: it says "Click" — the shared copy cannot.
    for (const key of ['device-events', 'system', 'alarm'] as const) {
      const section = NC_RULE_SECTIONS.find((s) => s.key === key)
      expect(section?.creatable).toBe(true)
      expect(section?.emptyHint).toContain(`Click "${section?.newRuleLabel}"`)
    }
    const mixed = NC_RULE_SECTIONS.find((s) => s.key === 'mixed')
    expect(mixed?.creatable).toBe(false)
    expect(mixed?.blurb).toContain('Open none of them: Delete each once its replacements exist.')
    expect(NC_RULE_SECTIONS.filter((s) => !s.creatable).map((s) => s.key)).toEqual(['mixed'])
  })

  it('shows "To recreate" only while it holds a rule', () => {
    expect(visibleRuleSections(new Map([['mixed', 0]])).map((s) => s.key)).not.toContain('mixed')
    expect(visibleRuleSections(new Map()).map((s) => s.key)).not.toContain('mixed')
    expect(visibleRuleSections(new Map([['mixed', 2]])).map((s) => s.key)).toContain('mixed')
    // Every other section is always there, empty or not.
    expect(visibleRuleSections(new Map()).map((s) => s.key)).toEqual(
      NC_RULE_SECTIONS.filter((s) => s.key !== 'mixed').map((s) => s.key),
    )
  })

  it('a mixed rule is readable and deletable, never editable', () => {
    const mixed = {
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['device-offline', 'node-offline'] } },
    }
    expect(isRuleEditable(mixed)).toBe(false)
    expect(isRuleEditable({ delivery: 'system-event', conditions: {} })).toBe(false)
    expect(
      isRuleEditable({
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['node-offline'] } },
      }),
    ).toBe(true)
    expect(isRuleEditable({ delivery: 'immediate', conditions: {} })).toBe(true)
  })

  it('drops the Devices tab for every system family', () => {
    const families: readonly (readonly NcSystemEventKind[])[] = [
      ['device-offline'],
      ['node-offline'],
      ['alarm-armed'],
    ]
    for (const kinds of families) {
      expect(
        ruleTabsFor('system-event', { systemEvent: { kinds: [...kinds] } }).map((t) => t.key),
      ).not.toContain('devices')
    }
  })

  it('names the sections whose rules are system rules', () => {
    for (const key of ['device-events', 'system', 'alarm', 'mixed'] as const) {
      expect(isSystemSectionKey(key)).toBe(true)
    }
    for (const key of ['all', 'detection', 'audio', 'occupancy'] as const) {
      expect(isSystemSectionKey(key)).toBe(false)
    }
  })
})
