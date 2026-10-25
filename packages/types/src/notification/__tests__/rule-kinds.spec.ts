/**
 * THE PIN for the shared rule-KIND and rule-SECTION model.
 *
 * This module is consumed by two editors that ship on different trains (the
 * admin UI with `camstack deploy`, the viewer with an EAS OTA), so nothing here
 * may be "obviously right": every claim it makes about the engine is asserted
 * against the real served catalog, and the two halves are asserted against each
 * other — a seed that does not classify back into the section that produced it
 * is a "New occupancy rule" button that opens a detection rule.
 *
 * The exclusions are the load-bearing content. Both directions are checked:
 *
 *  - every excluded id must EXIST in the real catalog, and must be a condition
 *    the kind's own delivery actually offers. An exclusion of something the
 *    delivery never offered is a leftover that reads as verification.
 *  - every condition the catalog offers for a sub-kind's delivery must be
 *    CLASSIFIED — allowed or excluded-with-a-reason. That is the direction that
 *    matters: a condition added server-side for `device-event` now fails this
 *    spec until somebody decides whether an occupancy rule can use it, which is
 *    exactly the decision that was never made for `sensorKinds`.
 *
 * The truths asserted about the ENGINE are pinned server-side by
 * `addon-post-analysis/.../rule-test-plan.spec.ts`, which fires each kind's
 * planned subject through the real `evaluateRule`.
 */
import { describe, expect, it } from 'vitest'
import {
  NC_CONDITION_CATALOG,
  type NcConditions,
  NcConditionsSchema,
  type NcDelivery,
  NcOccupancyConditionSchema,
} from '../../capabilities/notification-rules.cap.js'
import { EVENTFUL_CAP_NAMES } from '../../capabilities/sensor-event-kinds.js'
import { audioIsFailClosed } from '../audio-condition.js'
import {
  conditionExclusionReason,
  conditionVisibleForKind,
  defaultDeliveryForSection,
  droppedConditionsForKind,
  isAudioRule,
  isOccupancyRule,
  isSystemDelivery,
  isSystemRuleKind,
  kindsForDiscriminator,
  NC_AUDIO_SEED,
  NC_OCCUPANCY_DEFAULTS,
  NC_RULE_EDITOR_SECTION_ORDER,
  NC_RULE_KIND_SPECS,
  NC_RULE_SECTIONS,
  NC_SYSTEM_RULE_KINDS,
  type NcRuleEditorSectionKey,
  type NcRuleKind,
  type NcRuleSectionKey,
  type NcRuleSectionSubject,
  parseRuleSection,
  NC_CAMERA_SCOPE_CAP_NAME,
  ruleDeviceCompatCapNames,
  ruleDeviceCompatCapQueries,
  ruleEditorSectionsForKind,
  ruleKindOf,
  ruleKindSpec,
  ruleMatchesSection,
  ruleSectionOf,
  ruleSeedForSection,
  systemFamilyOfKind,
} from '../rule-kinds.js'

/** The delivery each kind rides — the engine's own pairing. */
const DELIVERY_BY_KIND: Readonly<Record<NcRuleKind, NcDelivery>> = {
  detection: 'immediate',
  sensor: 'device-event',
  occupancy: 'device-event',
  sound: 'immediate',
  'device-events': 'system-event',
  system: 'system-event',
  alarm: 'system-event',
  mixed: 'system-event',
}

function idsFor(delivery: NcDelivery): readonly string[] {
  return NC_CONDITION_CATALOG.filter((d) => d.appliesTo.includes(delivery)).map((d) => d.id)
}

function visibleIds(kind: NcRuleKind): readonly string[] {
  const delivery = DELIVERY_BY_KIND[kind]
  return NC_CONDITION_CATALOG.filter((d) => conditionVisibleForKind(d, delivery, kind)).map(
    (d) => d.id,
  )
}

const conditions = (c: NcConditions): NcConditions => c

// ── The kind model ──────────────────────────────────────────────────

describe('the kind map is consistent with the served catalog', () => {
  it.each(
    NC_RULE_KIND_SPECS.map((s) => s.kind),
  )('%s excludes only conditions its delivery actually offers', (kind) => {
    const offered = new Set(idsFor(DELIVERY_BY_KIND[kind]))
    for (const id of Object.keys(ruleKindSpec(kind).excluded)) {
      expect(offered.has(id), `${kind} excludes ${id}, which its delivery never offered`).toBe(true)
    }
  })

  it.each(
    NC_RULE_KIND_SPECS.map((s) => s.kind),
  )('%s classifies every offered condition', (kind) => {
    const spec = ruleKindSpec(kind)
    for (const id of idsFor(DELIVERY_BY_KIND[kind])) {
      const descriptor = NC_CONDITION_CATALOG.find((d) => d.id === id)
      expect(descriptor, `${id} vanished from the catalog`).toBeDefined()
      const classified =
        id === spec.discriminator ||
        spec.excluded[id] !== undefined ||
        // Allowed: visible, and therefore a deliberate decision that this kind
        // can use it. Asserting the function agrees with the map is the point —
        // a third state would mean the composition is not total.
        (descriptor !== undefined &&
          conditionVisibleForKind(descriptor, DELIVERY_BY_KIND[kind], kind))
      expect(classified, `${kind} does not classify ${id}`).toBe(true)
    }
  })

  it('every exclusion carries a reason a human can read', () => {
    for (const spec of NC_RULE_KIND_SPECS) {
      for (const [id, reason] of Object.entries(spec.excluded)) {
        expect(reason.length, `${spec.kind}/${id} has no reason`).toBeGreaterThan(30)
        expect(conditionExclusionReason(id, spec.kind)).toBe(reason)
      }
    }
  })

  it('a discriminator is never excluded by its own kind', () => {
    for (const spec of NC_RULE_KIND_SPECS) {
      if (spec.discriminator === undefined) continue
      expect(conditionExclusionReason(spec.discriminator, spec.kind)).toBeNull()
    }
  })
})

describe('what each kind actually shows', () => {
  it('OCCUPANCY drops the three device-event fields it can never satisfy', () => {
    const visible = visibleIds('occupancy')
    // The operator's report, verbatim: these are the fields that "non hanno
    // senso". Each fails closed on an occupancy subject — no sensorKind, no
    // eventType, and always the `pipeline` source.
    expect(visible).not.toContain('sensorKinds')
    expect(visible).not.toContain('eventTypeTokens')
    expect(visible).not.toContain('source')
    // …and keeps the ones it does use — including the two GATES. A gate narrows
    // a rule that already has a trigger; it asserts nothing about the subject,
    // so there is nothing for an occupancy edge to fail closed on.
    expect(visible).toEqual([
      'devices',
      'devicesExclude',
      'deviceState',
      'scene',
      'occupancy',
      'schedule',
    ])
  })

  it('SOUND keeps only the fields a sampling window can answer, plus the gates', () => {
    expect(visibleIds('sound')).toEqual([
      'devices',
      'devicesExclude',
      'deviceState',
      'scene',
      'audio',
      'schedule',
    ])
  })

  it('SENSOR keeps its own two discriminators, and the occupancy CONVERSION', () => {
    const visible = visibleIds('sensor')
    expect(visible).toContain('sensorKinds')
    expect(visible).toContain('eventTypeTokens')
    // Offered, not subtracted: authoring it turns the rule into an occupancy
    // rule, which is how an operator converts one — and the editor follows the
    // conversion live rather than refusing it.
    expect(visible).toContain('occupancy')
  })

  it('every SYSTEM kind shows the event picker and the schedule, and nothing else', () => {
    for (const kind of NC_SYSTEM_RULE_KINDS) {
      expect(visibleIds(kind), kind).toEqual(['systemEvent', 'schedule'])
    }
  })

  it('DETECTION never offers a sound — a sound is its own kind of rule (R13, D690)', () => {
    const visible = visibleIds('detection')
    expect(visible).toContain('classes')
    expect(visible).toContain('zones')
    expect(visible).toContain('crossing')
    expect(visible).toContain('plates')
    // Authoring `audio` on a detection rule converted it into a sound rule and
    // dropped every detection field on save — the rule broke itself.
    expect(visible).not.toContain('audio')
    expect(Object.keys(ruleKindSpec('detection').excluded)).toEqual(['audio'])
  })

  it('only a SYSTEM event cannot carry media at all', () => {
    expect(ruleKindSpec('detection').carriesMedia).toBe(true)
    expect(ruleKindSpec('sensor').carriesMedia).toBe(true)
    expect(ruleKindSpec('occupancy').carriesMedia).toBe(true)
    expect(ruleKindSpec('sound').carriesMedia).toBe(true)
    for (const kind of NC_SYSTEM_RULE_KINDS) {
      expect(ruleKindSpec(kind).carriesMedia, kind).toBe(false)
      expect(ruleKindSpec(kind).carriesSubjectCrop, kind).toBe(false)
    }
  })

  it('a SOUND rule gets the picture but not the controls that CUT one', () => {
    expect(ruleKindSpec('sound').carriesSubjectCrop).toBe(false)
    expect(ruleKindSpec('detection').carriesSubjectCrop).toBe(true)
    expect(ruleKindSpec('sensor').carriesSubjectCrop).toBe(true)
    expect(ruleKindSpec('occupancy').carriesSubjectCrop).toBe(true)
    // …and the operator is told what the picture IS, not merely shown a control.
    expect(ruleKindSpec('sound').mediaBlurb).toBeDefined()
  })
})

describe('ruleKindOf', () => {
  it('reads the CONDITION, not the trigger, for the two sub-kinds', () => {
    expect(
      ruleKindOf({
        delivery: 'device-event',
        conditions: conditions({ occupancy: { op: '>=', count: 1, sustainSeconds: 15 } }),
      }),
    ).toBe('occupancy')
    expect(
      ruleKindOf({
        delivery: 'immediate',
        conditions: conditions({
          audio: { hitPercent: 60, samplingSeconds: 10, dbThreshold: -30 },
        }),
      }),
    ).toBe('sound')
  })

  it('refuses to promote a condition riding the WRONG trigger', () => {
    // The engine fails such a rule closed (`fail('occupancy')` on an immediate
    // subject), so it is not an occupancy rule — it is a broken detection rule,
    // and showing it the occupancy editor would hide that.
    expect(
      ruleKindOf({
        delivery: 'immediate',
        conditions: conditions({ occupancy: { op: '>=', count: 1, sustainSeconds: 15 } }),
      }),
    ).toBe('detection')
  })

  it('classifies an unknown trigger as a detection rule rather than throwing', () => {
    expect(ruleKindOf({ delivery: 'something-new', conditions: {} })).toBe('detection')
  })

  /**
   * A LITERAL carrying conditions this classifier does not read must still be a
   * legal argument.
   *
   * `NcRuleConditionsSubject` names exactly the two keys the question turns on,
   * and TypeScript's excess-property check then rejects `{ classes: [...] }`
   * written INLINE — while the identical value read out of a variable is
   * accepted. Both editors write such literals (specs, seeds, the admin's
   * section tests), so the shape has to admit the rest of the conditions
   * explicitly rather than by accident of where the value came from.
   */
  it('accepts a conditions LITERAL carrying keys it does not read', () => {
    expect(ruleKindOf({ delivery: 'immediate', conditions: { classes: ['person'] } })).toBe(
      'detection',
    )
    expect(
      ruleMatchesSection(
        { delivery: 'system-event', conditions: { systemEvent: { kinds: ['node-offline'] } } },
        'system',
      ),
    ).toBe(true)
    expect(ruleSectionOf({ delivery: 'immediate', conditions: { classes: ['person'] } })).toBe(
      'detection',
    )
  })
})

describe('droppedConditionsForKind', () => {
  it('names what a save would drop, and why', () => {
    const dropped = droppedConditionsForKind(
      {
        occupancy: { op: '>=', count: 2, sustainSeconds: 15 },
        sensorKinds: ['doorbell'],
        source: 'sensor',
        devices: [102],
      },
      'occupancy',
    )
    expect(dropped.map((d) => d.conditionId).sort()).toEqual(['sensorKinds', 'source'])
    for (const entry of dropped) expect(entry.reason.length).toBeGreaterThan(30)
  })

  it('ignores an EMPTY list — nothing is dropped and nothing is announced', () => {
    expect(droppedConditionsForKind({ sensorKinds: [] }, 'occupancy')).toEqual([])
  })
})

// ── The section model ───────────────────────────────────────────────

describe('the section model', () => {
  it('offers the nine sections, `all` first and `mixed` last', () => {
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
  })

  it('every section names its own create button and its own empty state', () => {
    for (const section of NC_RULE_SECTIONS) {
      expect(section.newRuleLabel.length, `${section.key} has no create label`).toBeGreaterThan(0)
      expect(section.emptyHint.length, `${section.key} has no empty hint`).toBeGreaterThan(10)
      expect(section.blurb.length, `${section.key} has no blurb`).toBeGreaterThan(10)
    }
  })

  it('narrows a raw key and refuses an unknown one (no cast)', () => {
    expect(parseRuleSection('occupancy')).toBe('occupancy')
    expect(parseRuleSection('timelapse')).toBeUndefined()
  })

  it('`all` hides nothing — a section that hides a rule is how one looks deleted', () => {
    const subjects = [
      { delivery: 'immediate', conditions: {} },
      { delivery: 'system-event', conditions: {} },
      { delivery: 'something-new', conditions: {} },
    ]
    for (const subject of subjects) expect(ruleMatchesSection(subject, 'all')).toBe(true)
  })

  it('the real sections PARTITION every rule — exactly one each', () => {
    const real: readonly NcRuleSectionKey[] = [
      'detection',
      'sensor',
      'audio',
      'occupancy',
      'device-events',
      'system',
      'alarm',
      'mixed',
    ]
    const subjects = [
      { delivery: 'immediate', conditions: {} },
      { delivery: 'track-end', conditions: {} },
      { delivery: 'package-event', conditions: {} },
      // `device-event` with no occupancy condition is a SENSOR rule, not a
      // detection rule (operator ruling, 2026-10-01) — a doorbell press used
      // to fall into `detection` for want of its own section.
      { delivery: 'device-event', conditions: {} },
      { delivery: 'system-event', conditions: {} },
      {
        delivery: 'immediate',
        conditions: conditions({ audio: { hitPercent: 60, samplingSeconds: 10 } }),
      },
      {
        delivery: 'device-event',
        conditions: conditions({ occupancy: { op: '>=', count: 1, sustainSeconds: 15 } }),
      },
      // A trigger this build has never heard of still lands somewhere.
      { delivery: 'something-new', conditions: {} },
    ]
    for (const subject of subjects) {
      const hits = real.filter((key) => ruleMatchesSection(subject, key))
      expect(hits, `${subject.delivery} matched ${hits.join('+')}`).toHaveLength(1)
      expect(ruleSectionOf(subject)).toBe(hits[0])
    }
  })

  it('claims sound and occupancy by their CONDITION, system by its trigger', () => {
    expect(
      isAudioRule({
        delivery: 'immediate',
        conditions: { audio: { hitPercent: 60, samplingSeconds: 10 } },
      }),
    ).toBe(true)
    expect(
      isOccupancyRule({
        delivery: 'device-event',
        conditions: { occupancy: { op: '>=', count: 1, sustainSeconds: 15 } },
      }),
    ).toBe(true)
    expect(isSystemDelivery('system-event')).toBe(true)
    expect(isSystemDelivery('immediate')).toBe(false)
  })
})

describe('the seeds a "New rule" opens on', () => {
  it('seeds each section so the new rule CLASSIFIES back into it', () => {
    // The one that matters: a "New occupancy rule" that opens a detection rule
    // is the 2026-08-13 gap wearing a different hat.
    for (const section of NC_RULE_SECTIONS) {
      // `mixed` is derived and never authored — it has no create button to seed.
      if (section.key === 'all' || !section.creatable) continue
      const seed = ruleSeedForSection(section.key)
      expect(ruleMatchesSection(seed, section.key), `${section.key} seed misclassifies`).toBe(true)
    }
  })

  it('the DEFAULT section seeds an immediate rule on the PIPELINE source (R5, D690)', () => {
    const seeded = { delivery: 'immediate', conditions: { source: 'pipeline' } }
    expect(ruleSeedForSection('all')).toEqual(seeded)
    expect(ruleSeedForSection('detection')).toEqual(seeded)
    expect(defaultDeliveryForSection('all')).toBe('immediate')
    expect(defaultDeliveryForSection('occupancy')).toBe('device-event')
    expect(defaultDeliveryForSection('system')).toBe('system-event')
  })

  it('every seed is a VALID conditions object on the wire', () => {
    for (const section of NC_RULE_SECTIONS) {
      expect(() =>
        NcConditionsSchema.parse(ruleSeedForSection(section.key).conditions),
      ).not.toThrow()
    }
  })

  it('the occupancy seed IS the schema default — two copies is how a preset drifts', () => {
    expect(NC_OCCUPANCY_DEFAULTS).toEqual(NcOccupancyConditionSchema.parse({}))
    expect(ruleSeedForSection('occupancy').conditions.occupancy).toEqual(NC_OCCUPANCY_DEFAULTS)
  })

  it('the sound seed can actually FIRE — a fail-closed preset is a dead rule', () => {
    expect(audioIsFailClosed(NC_AUDIO_SEED)).toBe(false)
    expect(NC_AUDIO_SEED.dbThreshold).toBeLessThan(0)
  })

  it('the seeded kind is the section it came from', () => {
    expect(ruleKindOf(ruleSeedForSection('audio'))).toBe('sound')
    expect(ruleKindOf(ruleSeedForSection('occupancy'))).toBe('occupancy')
    expect(ruleKindOf(ruleSeedForSection('device-events'))).toBe('device-events')
    expect(ruleKindOf(ruleSeedForSection('system'))).toBe('system')
    expect(ruleKindOf(ruleSeedForSection('alarm'))).toBe('alarm')
    expect(ruleKindOf(ruleSeedForSection('detection'))).toBe('detection')
    expect(ruleKindOf(ruleSeedForSection('sensor'))).toBe('sensor')
  })

  it("'New sensor rule' seeds a bare device-event, with no occupancy condition", () => {
    // Bare, not `{ delivery: 'device-event', conditions: {} }` by accident:
    // an occupancy condition on it would make `ruleKindOf` read 'occupancy'
    // instead, the same trap `ruleMatchesSection`'s `sensor` branch guards
    // against on a STORED rule.
    expect(ruleSeedForSection('sensor')).toEqual({ delivery: 'device-event', conditions: {} })
  })
})

// ── The editor-section contract ─────────────────────────────────────

describe('the editor sections', () => {
  it('are the admin tab order, stated once', () => {
    expect(NC_RULE_EDITOR_SECTION_ORDER).toEqual([
      'rule',
      'devices',
      'conditions',
      'notification',
      'actions',
      'advanced',
    ])
  })

  it.each(
    NC_RULE_KIND_SPECS.map((s) => s.kind),
  )('%s renders a SUBSEQUENCE of that order — never a reshuffle', (kind) => {
    const keys = ruleEditorSectionsForKind(kind).map((s) => s.key)
    const positions = keys.map((key: NcRuleEditorSectionKey) =>
      NC_RULE_EDITOR_SECTION_ORDER.indexOf(key),
    )
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(positions).not.toContain(-1)
  })

  it('a SYSTEM rule has no device scope, so it has no Cameras section', () => {
    // `buildRuleInput` refuses to write `conditions.devices` for it — a section
    // shown and then ignored is worse than one that is absent.
    for (const kind of NC_SYSTEM_RULE_KINDS) {
      expect(
        ruleEditorSectionsForKind(kind).map((s) => s.key),
        kind,
      ).not.toContain('devices')
    }
    expect(ruleEditorSectionsForKind('occupancy').map((s) => s.key)).toContain('devices')
  })

  it('NAMES the conditions section after the kind — the only place the feature exists', () => {
    const labelOf = (kind: NcRuleKind): string | undefined =>
      ruleEditorSectionsForKind(kind).find((s) => s.key === 'conditions')?.label
    expect(labelOf('sound')).toBe('Sound')
    expect(labelOf('occupancy')).toBe('Occupancy')
    expect(labelOf('device-events')).toBe('Device events')
    expect(labelOf('system')).toBe('System events')
    expect(labelOf('alarm')).toBe('Alarm')
    expect(labelOf('detection')).toBe('Conditions')
  })
})

// ── D637: the three system-rule families ────────────────────────────

describe('D637 — system rules split into three families', () => {
  const sys = (kinds: readonly string[]): NcRuleSectionSubject => ({
    delivery: 'system-event',
    conditions: { systemEvent: { kinds } },
  })

  it('derives the kind from the EVENT kinds', () => {
    expect(ruleKindOf(sys(['device-offline', 'device-battery-low']))).toBe('device-events')
    expect(ruleKindOf(sys(['node-offline', 'export-completed']))).toBe('system')
    expect(ruleKindOf(sys(['alarm-triggered']))).toBe('alarm')
  })

  it('derives mixed across families, on a legacy kind, and on no condition', () => {
    expect(ruleKindOf(sys(['device-offline', 'node-offline']))).toBe('mixed')
    expect(ruleKindOf(sys(['camera-offline']))).toBe('mixed')
    expect(ruleKindOf({ delivery: 'system-event', conditions: {} })).toBe('mixed')
  })

  it('mixed is readable but not editable; every other kind is editable', () => {
    for (const spec of NC_RULE_KIND_SPECS)
      expect(spec.editable, spec.kind).toBe(spec.kind !== 'mixed')
  })

  it('every family seed classifies back into its own section and kind', () => {
    for (const section of ['device-events', 'system', 'alarm'] as const) {
      const seed = ruleSeedForSection(section)
      expect(seed.delivery).toBe('system-event')
      expect(ruleKindOf(seed)).toBe(section)
      expect(ruleSectionOf(seed)).toBe(section)
    }
  })

  it('partitions stored rules: each system rule in exactly one family section, or in mixed', () => {
    const rules = [
      sys(['device-offline']),
      sys(['node-offline']),
      sys(['alarm-armed']),
      sys(['device-offline', 'alarm-armed']),
    ]
    expect(rules.map(ruleSectionOf)).toEqual(['device-events', 'system', 'alarm', 'mixed'])
    for (const rule of rules) {
      const owning = NC_RULE_SECTIONS.filter(
        (s) => s.key !== 'all' && ruleMatchesSection(rule, s.key),
      )
      expect(owning).toHaveLength(1)
    }
  })

  it('mixed is not creatable; every other section is', () => {
    for (const s of NC_RULE_SECTIONS) expect(s.creatable, s.key).toBe(s.key !== 'mixed')
  })

  it('drops the Cameras editor section for every system kind', () => {
    for (const kind of NC_SYSTEM_RULE_KINDS) {
      expect(ruleEditorSectionsForKind(kind).map((s) => s.key)).not.toContain('devices')
    }
  })

  it('a system-family kind shows the systemEvent condition and the schedule gate from the served catalog', () => {
    for (const kind of NC_SYSTEM_RULE_KINDS) {
      const visible = NC_CONDITION_CATALOG.filter((d) =>
        conditionVisibleForKind(d, 'system-event', kind),
      )
      expect(
        visible.map((d) => d.id),
        kind,
      ).toEqual(['systemEvent', 'schedule'])
    }
  })

  it('a discriminator may be SHARED by a group of kinds — only the system group shares one', () => {
    // The invariant a consumer must not break: mapping a discriminator back to
    // ONE kind (a Map keyed on it) keeps the last spec — `mixed` — and would
    // lock the event picker out of every family rule.
    expect(kindsForDiscriminator('systemEvent')).toEqual([...NC_SYSTEM_RULE_KINDS])
    expect(kindsForDiscriminator('audio')).toEqual(['sound'])
    expect(kindsForDiscriminator('occupancy')).toEqual(['occupancy'])
    expect(kindsForDiscriminator('classes')).toEqual([])
    for (const spec of NC_RULE_KIND_SPECS) {
      if (spec.discriminator === undefined) continue
      const group = kindsForDiscriminator(spec.discriminator)
      expect(group, spec.kind).toContain(spec.kind)
      if (group.length > 1) {
        for (const kind of group) expect(isSystemRuleKind(kind), kind).toBe(true)
      }
    }
  })

  it('systemFamilyOfKind: the family for the three, undefined otherwise', () => {
    expect(systemFamilyOfKind('device-events')).toBe('device-events')
    expect(systemFamilyOfKind('system')).toBe('system')
    expect(systemFamilyOfKind('alarm')).toBe('alarm')
    expect(systemFamilyOfKind('mixed')).toBeUndefined()
    expect(systemFamilyOfKind('detection')).toBeUndefined()
  })
})

describe('the served zone-crossing choices (D690, old-viewer compatibility)', () => {
  const crossing = NC_CONDITION_CATALOG.find((d) => d.id === 'crossing')

  it('serve entering as the ABSENT value an old viewer reads as unset', () => {
    // A viewer ≤1.0.565 drops `enter` from the served set and binds
    // `value ?? ''`; without a `''` choice it can never select entering again.
    expect(crossing?.options?.map((o) => o.value)).toEqual(['', 'exit', 'any'])
    expect(crossing?.options?.[0]?.label).toBe('Entering')
  })
})

// ── Which devices a rule's scope picker offers (operator ruling, 2026-10-01) ─

describe('ruleDeviceCompatCapNames', () => {
  it('sensor reads the SAME taxonomy table the engine turns bound caps into event kinds with', () => {
    // Not a hand-picked list: a device this names is exactly a device whose
    // bound caps `EVENT_KIND_BY_CAP` could ever turn into a `sensorKinds`
    // value, because it is the identical constant.
    expect(ruleDeviceCompatCapNames('sensor')).toBe(EVENTFUL_CAP_NAMES)
  })

  it('detection and occupancy read the pipeline cap — package rides detection (D637, no separate kind)', () => {
    expect(ruleDeviceCompatCapNames('detection')).toEqual(['detection-pipeline'])
    expect(ruleDeviceCompatCapNames('occupancy')).toEqual(['detection-pipeline'])
  })

  it('sound reads the audio-metrics cap', () => {
    expect(ruleDeviceCompatCapNames('sound')).toEqual(['audio-metrics'])
  })

  it('every system family and mixed are null — no capability filter, each its own reason', () => {
    for (const kind of ['device-events', 'system', 'alarm', 'mixed'] as const) {
      expect(ruleDeviceCompatCapNames(kind)).toBeNull()
    }
  })

  it('a cap-names answer never exceeds the cap the wire method takes (max 16)', () => {
    for (const kind of NC_RULE_KIND_SPECS.map((s) => s.kind)) {
      const names = ruleDeviceCompatCapNames(kind)
      if (names !== null) expect(names.length).toBeLessThanOrEqual(16)
    }
  })
})

describe('ruleDeviceCompatCapQueries — the set a rule may be SCOPED to', () => {
  it('a sensor rule may also scope a CAMERA (D630 §6) — the eventful caps plus the camera cap', () => {
    expect(ruleDeviceCompatCapQueries('sensor')).toEqual([
      EVENTFUL_CAP_NAMES,
      [NC_CAMERA_SCOPE_CAP_NAME],
    ])
    expect(NC_CAMERA_SCOPE_CAP_NAME).toBe('camera-streams')
  })

  it('every other kind asks exactly its picker list, and null stays null', () => {
    expect(ruleDeviceCompatCapQueries('detection')).toEqual([['detection-pipeline']])
    expect(ruleDeviceCompatCapQueries('sound')).toEqual([['audio-metrics']])
    for (const kind of ['device-events', 'system', 'alarm', 'mixed'] as const) {
      expect(ruleDeviceCompatCapQueries(kind)).toBeNull()
    }
  })

  it('every query fits the wire method (max 16 names)', () => {
    for (const kind of NC_RULE_KIND_SPECS.map((s) => s.kind)) {
      for (const query of ruleDeviceCompatCapQueries(kind) ?? []) {
        expect(query.length).toBeGreaterThan(0)
        expect(query.length).toBeLessThanOrEqual(16)
      }
    }
  })
})
