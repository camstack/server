/**
 * A narrowing filter belongs to a FAMILY of system-event kinds, and a kind
 * outside that family is not narrowed by it — nor silently excluded by it.
 *
 * ── The live failure this pins ─────────────────────────────────────────────
 * The operator's rule "Eventi di sistema" (id `091937f1-…`) selects eleven
 * kinds and sets `deviceTypes: ['camera']`, because that is the only way to say
 * "only my cameras" about the two liveness kinds. `matchesSystemEvent` applied
 * that filter to all eleven, and only `device-online` / `device-offline` carry
 * a `deviceType` — so nine kinds failed CLOSED. Four days of
 * `notificationRules.getHistory` (limit 300) contained 66 `device-online` and
 * 69 `device-offline` and NOT ONE of the other nine, across a window in which
 * agents were restarted and addons were updated.
 *
 * All four filters were unscoped, so the same hole existed in every direction:
 * a `nodeIds` on a device rule, a `deviceIds` on a node rule, a `packageNames`
 * on `node-offline`.
 *
 * The cap docblock already promised the scoping ("Narrow a `device-*` kind to
 * these device TYPES") and BOTH rule editors already computed it to decide
 * which filter boxes to render. Only the engine disagreed.
 *
 * ── The direction that matters ────────────────────────────────────────────
 * Out of family ⇒ IGNORED, never fail-closed. Dropping a notification is the
 * destructive direction (D49), and an editor that hides the box has already
 * told the operator this filter does not speak about these kinds.
 */
import type { NcSystemEventCondition, NcSystemEventKind } from '@camstack/types'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, NC_SYSTEM_DEVICE_ID, type NcRuleSubject } from '../rule-engine.js'

/** The optional half of a system-event condition, as an editor writes it. */
type SystemEventFilters = Omit<NcSystemEventCondition, 'kinds'>

/** The identity a system subject carries, per kind family. */
type SubjectIdentity = Partial<NonNullable<NcRuleSubject['systemEvent']>>

/**
 * A value for EVERY filter, none of which any subject below can satisfy.
 *
 * Whatever is in-family for a given kind is overridden with the subject's own
 * identity; whatever is left is out-of-family, unsatisfiable, and must be
 * ignored. So one `matched: true` proves the scoping in all four directions at
 * once.
 */
const UNSATISFIABLE: SystemEventFilters = {
  deviceIds: [1],
  deviceTypes: ['camera'],
  nodeIds: ['a-node-that-does-not-exist'],
  packageNames: ['@camstack/never-installed'],
}

function ruleWith(kinds: readonly NcSystemEventKind[], filters: SystemEventFilters) {
  const input = NcRuleInputSchema.parse({
    name: 'Eventi di sistema',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds: [...kinds], ...filters } },
    targets: [{ targetId: 'zentik-1' }],
  })
  return NcRuleSchema.parse({
    ...input,
    id: 'rule-live',
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
}

function systemSubject(kind: NcSystemEventKind, identity: SubjectIdentity = {}): NcRuleSubject {
  return {
    kind: 'system-event',
    recordId: `event-${kind}`,
    // The system subject's own device id is the SENTINEL — the real one, when
    // there is one, lives on `systemEvent.deviceId`.
    deviceId: NC_SYSTEM_DEVICE_ID,
    timestamp: 1_000,
    classNames: [],
    zones: [],
    systemEvent: {
      kind,
      subject: `system:${kind}`,
      data: {},
      ...identity,
    },
  }
}

/**
 * The eight kinds the live rule selected and never received — each with the
 * identity it actually carries, and the filters that are genuinely ABOUT it.
 *
 * `inFamily` is written out by hand rather than derived from the shared
 * predicate on purpose: a test that computes its own expectation from the code
 * under test proves nothing. These are the families as a person reads them.
 */
const STARVED_KINDS: ReadonlyArray<{
  readonly kind: NcSystemEventKind
  readonly carries: SubjectIdentity
  readonly inFamily: SystemEventFilters
}> = [
  {
    kind: 'node-offline',
    carries: { nodeId: 'agent-a' },
    inFamily: { nodeIds: ['agent-a'] },
  },
  {
    kind: 'node-online',
    carries: { nodeId: 'agent-a' },
    inFamily: { nodeIds: ['agent-a'] },
  },
  {
    kind: 'stream-offline',
    carries: { deviceId: 102 },
    inFamily: { deviceIds: [102] },
  },
  {
    kind: 'stream-online',
    carries: { deviceId: 102 },
    inFamily: { deviceIds: [102] },
  },
  {
    kind: 'addon-update-available',
    carries: { nodeId: 'agent-a', packageName: '@camstack/addon-pipeline' },
    inFamily: { nodeIds: ['agent-a'], packageNames: ['@camstack/addon-pipeline'] },
  },
  {
    kind: 'server-update-available',
    carries: { nodeId: 'hub', packageName: '@camstack/server' },
    inFamily: { nodeIds: ['hub'], packageNames: ['@camstack/server'] },
  },
  {
    kind: 'addon-updated',
    carries: { nodeId: 'agent-a', packageName: '@camstack/addon-pipeline' },
    inFamily: { nodeIds: ['agent-a'], packageNames: ['@camstack/addon-pipeline'] },
  },
  {
    kind: 'server-updated',
    carries: { nodeId: 'hub', packageName: '@camstack/server' },
    inFamily: { nodeIds: ['hub'], packageNames: ['@camstack/server'] },
  },
]

/** The rule as the operator actually saved it. */
const LIVE_KINDS: readonly NcSystemEventKind[] = [
  'device-offline',
  'device-online',
  'stream-offline',
  'stream-online',
  'node-offline',
  'node-online',
  'addon-update-available',
  'server-update-available',
  'addon-updated',
  'server-updated',
  'export-completed',
]

describe("the live rule's eight starved kinds", () => {
  const rule = ruleWith(LIVE_KINDS, { deviceTypes: ['camera'] })

  for (const { kind, carries } of STARVED_KINDS) {
    it(`delivers ${kind} even though the rule sets deviceTypes: ['camera']`, () => {
      const evaluation = evaluateRule(rule, systemSubject(kind, carries))
      expect(evaluation.matched, evaluation.failedCondition ?? 'matched').toBe(true)
    })
  }

  it('still delivers the two kinds that DID work', () => {
    for (const kind of ['device-offline', 'device-online'] as const) {
      const evaluation = evaluateRule(
        rule,
        systemSubject(kind, { deviceId: 102, deviceType: 'camera' }),
      )
      expect(evaluation.matched, kind).toBe(true)
    }
  })
})

describe('a foreign filter never closes a kind', () => {
  for (const { kind, carries, inFamily } of STARVED_KINDS) {
    it(`matches ${kind} with every out-of-family filter set to a value it cannot satisfy`, () => {
      const evaluation = evaluateRule(
        ruleWith([kind], { ...UNSATISFIABLE, ...inFamily }),
        systemSubject(kind, carries),
      )
      expect(evaluation.matched, evaluation.failedCondition ?? 'matched').toBe(true)
      expect(evaluation.excludedBySystemEventFilter).toBeUndefined()
    })
  }

  it('ignores deviceIds on a node kind rather than closing it', () => {
    expect(
      evaluateRule(
        ruleWith(['node-offline'], { deviceIds: [104] }),
        systemSubject('node-offline', { nodeId: 'agent-a' }),
      ).matched,
    ).toBe(true)
  })

  it('ignores nodeIds on a device kind rather than closing it', () => {
    expect(
      evaluateRule(
        ruleWith(['device-offline'], { nodeIds: ['agent-a'] }),
        systemSubject('device-offline', { deviceId: 104, deviceType: 'camera' }),
      ).matched,
    ).toBe(true)
  })

  it('ignores packageNames on a node kind rather than closing it', () => {
    expect(
      evaluateRule(
        ruleWith(['node-offline'], { packageNames: ['@camstack/addon-pipeline'] }),
        systemSubject('node-offline', { nodeId: 'agent-a' }),
      ).matched,
    ).toBe(true)
  })

  it('ignores deviceTypes on a stream kind — a stream carries no type by design', () => {
    expect(
      evaluateRule(
        ruleWith(['stream-offline'], { deviceTypes: ['camera'] }),
        systemSubject('stream-offline', { deviceId: 101 }),
      ).matched,
    ).toBe(true)
  })
})

/**
 * fc7c0b288's intent, unchanged: inside its own family a filter still narrows,
 * and still fails CLOSED on a device the mirror cannot name.
 */
describe('a filter still narrows the kinds it belongs to', () => {
  const cameraRule = (kind: NcSystemEventKind) => ruleWith([kind], { deviceTypes: ['camera'] })

  for (const kind of ['device-offline', 'device-online', 'detection-blind'] as const) {
    it(`narrows ${kind} to cameras`, () => {
      expect(
        evaluateRule(cameraRule(kind), systemSubject(kind, { deviceId: 102, deviceType: 'camera' }))
          .matched,
      ).toBe(true)
      expect(
        evaluateRule(
          cameraRule(kind),
          systemSubject(kind, { deviceId: 2018, deviceType: 'switch' }),
        ).matched,
      ).toBe(false)
    })

    it(`fails ${kind} CLOSED when the mirror cannot name the device`, () => {
      const evaluation = evaluateRule(cameraRule(kind), systemSubject(kind, { deviceId: 9_999 }))
      expect(evaluation.matched).toBe(false)
      expect(evaluation.failedCondition).toBe('systemEvent')
    })
  }

  it('still narrows deviceIds inside the device family', () => {
    expect(
      evaluateRule(
        ruleWith(['device-offline'], { deviceIds: [102] }),
        systemSubject('device-offline', { deviceId: 104, deviceType: 'camera' }),
      ).matched,
    ).toBe(false)
  })

  it('still narrows nodeIds inside the node family', () => {
    expect(
      evaluateRule(
        ruleWith(['node-offline'], { nodeIds: ['agent-b'] }),
        systemSubject('node-offline', { nodeId: 'agent-a' }),
      ).matched,
    ).toBe(false)
  })

  it('still narrows nodeIds inside the UPDATE family — an update is pinned to a node', () => {
    expect(
      evaluateRule(
        ruleWith(['addon-update-available'], { nodeIds: ['hub'] }),
        systemSubject('addon-update-available', {
          nodeId: 'agent-a',
          packageName: '@camstack/addon-pipeline',
        }),
      ).matched,
    ).toBe(false)
  })

  it('still narrows packageNames inside the update family', () => {
    expect(
      evaluateRule(
        ruleWith(['addon-update-available'], { packageNames: ['@camstack/addon-recorder'] }),
        systemSubject('addon-update-available', { packageName: '@camstack/addon-pipeline' }),
      ).matched,
    ).toBe(false)
  })

  it('still narrows deviceIds inside the stream family', () => {
    expect(
      evaluateRule(
        ruleWith(['stream-offline'], { deviceIds: [101] }),
        systemSubject('stream-offline', { deviceId: 102 }),
      ).matched,
    ).toBe(false)
  })

  it('IGNORES a stored deviceIds on export-completed (D637: a system fact, never narrowed by device)', () => {
    expect(
      evaluateRule(
        ruleWith(['export-completed'], { deviceIds: [101] }),
        systemSubject('export-completed', { deviceId: 102 }),
      ).matched,
    ).toBe(true)
  })
})

/**
 * A legitimate exclusion is still a DROP, and a drop that logs nothing reads as
 * "the intake stopped emitting" — which is precisely how the eight starved kinds
 * went unnoticed for four days. The engine NAMES the filter so the caller can
 * say so, per camera.
 */
describe('an exclusion names the filter that caused it', () => {
  it('names deviceTypes when the type filter drops a device', () => {
    const evaluation = evaluateRule(
      ruleWith(['device-offline'], { deviceTypes: ['camera'] }),
      systemSubject('device-offline', { deviceId: 2018, deviceType: 'switch' }),
    )
    expect(evaluation.matched).toBe(false)
    expect(evaluation.excludedBySystemEventFilter).toBe('deviceTypes')
  })

  it('names deviceIds, nodeIds and packageNames the same way', () => {
    expect(
      evaluateRule(
        ruleWith(['device-offline'], { deviceIds: [102] }),
        systemSubject('device-offline', { deviceId: 104 }),
      ).excludedBySystemEventFilter,
    ).toBe('deviceIds')
    expect(
      evaluateRule(
        ruleWith(['node-offline'], { nodeIds: ['agent-b'] }),
        systemSubject('node-offline', { nodeId: 'agent-a' }),
      ).excludedBySystemEventFilter,
    ).toBe('nodeIds')
    expect(
      evaluateRule(
        ruleWith(['addon-updated'], { packageNames: ['@camstack/addon-recorder'] }),
        systemSubject('addon-updated', { packageName: '@camstack/addon-pipeline' }),
      ).excludedBySystemEventFilter,
    ).toBe('packageNames')
  })

  it('does NOT name a filter when the rule simply does not list the kind', () => {
    const evaluation = evaluateRule(
      ruleWith(['device-offline'], { deviceTypes: ['camera'] }),
      systemSubject('node-offline', { nodeId: 'agent-a' }),
    )
    expect(evaluation.matched).toBe(false)
    expect(evaluation.failedCondition).toBe('systemEvent')
    expect(evaluation.excludedBySystemEventFilter).toBeUndefined()
  })
})
