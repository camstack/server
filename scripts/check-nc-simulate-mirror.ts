#!/usr/bin/env tsx
/**
 * NC simulate-payload mirror guard — what the admin UI SENDS is what the
 * server ACCEPTS.
 *
 * ## The failure this catches
 *
 * `nc.injectTestEvent` rides the generic `addons.custom` bridge, whose input
 * and output are `z.unknown()` on the wire. That is what makes bridge actions
 * cheap — no codegen, no `@camstack/system` republish, no release train — and
 * it is also what removes every compile-time link between the two ends. The
 * admin UI cannot import addon source, so `NcSimulateInput` in
 * `notification-simulate.helpers.ts` is a HAND-WRITTEN mirror of
 * `NcTestEventInputSchema`.
 *
 * This repo has already paid for a hand-written mirror of a typed contract:
 * the Alexa export's cap interface rotted silently and the integration was
 * black for weeks, because a mirror that has drifted still compiles. Here the
 * drift would be quieter still — an added condition field the UI keeps sending
 * is silently STRIPPED by `NcTestEventInputSchema.parse`, so the simulation
 * runs, reports a clean verdict, and answers a question about a subject the
 * operator did not describe. A tester that lies is worse than no tester.
 *
 * ## What it checks
 *
 * It does not compare source text — it runs the real thing. For one form per
 * TRIGGER (plus the empty form), it builds the payload with the UI's own
 * `buildSimulateInput` / `prefillFromRule` and feeds it to the real
 * `NcTestEventInputSchema`:
 *
 *   1. the schema ACCEPTS it (no field the UI sends is rejected), and
 *   2. the schema KEEPS every key (no field the UI sends is silently dropped).
 *
 * Adding a field to the server schema alone does not fail this guard — the UI
 * simply does not offer it yet, which is a real and legitimate state. Adding a
 * field to the UI without the server, or renaming one on either side, does.
 */

import type { NcRule } from '@camstack/types'
import { NcTestEventInputSchema } from '../packages/addon-post-analysis/src/notification-center/test-event.js'
import {
  buildSimulateInput,
  emptySimulateForm,
  prefillFromRule,
} from '../packages/addon-admin-ui/src/pages/system/notification-simulate.helpers.js'

const BASE: NcRule = {
  id: 'guard-rule',
  name: 'guard',
  enabled: true,
  disabledTargetIds: [],
  delivery: 'immediate',
  conditions: {},
  targets: [{ targetId: 't' }],
  media: { attach: 'best' },
  throttle: { cooldownSec: 60, scope: 'rule-device' },
  priority: 3,
  createdBy: 'u',
  createdAt: 0,
  updatedAt: 0,
}

/** One rule per trigger, each exercising the fields only that trigger carries. */
const CASES: ReadonlyArray<{ readonly what: string; readonly rule: NcRule }> = [
  {
    what: 'object-event · classes + zones + confidence',
    rule: {
      ...BASE,
      conditions: {
        devices: [101],
        classes: ['person'],
        minConfidence: 0.7,
        zones: { ids: ['z1'], match: 'any' },
      },
    },
  },
  {
    what: 'object-event · crossing + custom polygons',
    rule: {
      ...BASE,
      conditions: {
        crossing: 'exit',
        zones: { ids: ['z9'], match: 'any' },
        customZones: [{ kind: 'polygon', points: [{ x: 0, y: 0 }] }],
      },
    },
  },
  {
    what: 'track-end · importance + dwell + identity',
    rule: {
      ...BASE,
      delivery: 'track-end',
      conditions: { minImportance: 0.5, minDwellSeconds: 4, identities: ['someone'] },
    },
  },
  {
    what: 'device-event · sensor kind + event token',
    rule: {
      ...BASE,
      delivery: 'device-event',
      conditions: { sensorKinds: ['doorbell'], eventTypeTokens: ['press'] },
    },
  },
  {
    what: 'device-event · occupancy edge',
    rule: {
      ...BASE,
      delivery: 'device-event',
      conditions: { occupancy: { op: '>=', count: 2, sustainSeconds: 15 } },
    },
  },
  {
    what: 'package-event · phase',
    rule: { ...BASE, delivery: 'package-event', conditions: { packagePhase: 'delivered' } },
  },
  {
    what: 'audio-event · audio class namespace',
    rule: { ...BASE, conditions: { classes: ['audio-dog'] } },
  },
]

const failures: string[] = []

for (const { what, rule } of CASES) {
  const payload = buildSimulateInput({ ...prefillFromRule(rule), deviceId: 101 })
  if (payload === null) {
    failures.push(`${what}: the UI produced no payload for a valid rule`)
    continue
  }
  const parsed = NcTestEventInputSchema.safeParse(payload)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    failures.push(`${what}: the server REJECTS what the UI sends — ${issues}`)
    continue
  }
  const dropped = Object.keys(payload).filter((key) => !(key in parsed.data))
  if (dropped.length > 0) {
    failures.push(
      `${what}: the server silently DROPS ${dropped.join(', ')} — the simulation would answer about a subject the operator did not describe`,
    )
  }
}

// The untouched form is the most-used payload of all, and the one most likely
// to acquire a field nobody re-checked.
const empty = buildSimulateInput({ ...emptySimulateForm(), deviceId: 101 })
if (empty === null) {
  failures.push('empty form: the UI produced no payload')
} else {
  const parsed = NcTestEventInputSchema.safeParse(empty)
  if (!parsed.success) {
    failures.push(`empty form: the server rejects the default payload — ${parsed.error.message}`)
  }
}

if (failures.length > 0) {
  console.error('✖ NC simulate payload mirror has drifted from NcTestEventInputSchema:\n')
  for (const f of failures) console.error(`  - ${f}`)
  console.error(
    '\nFix BOTH ends: `NcTestEventInputSchema` in\n' +
      '  packages/addon-post-analysis/src/notification-center/test-event.ts\n' +
      'and `NcSimulateInput` / `buildSimulateInput` in\n' +
      '  packages/addon-admin-ui/src/pages/system/notification-simulate.helpers.ts\n',
  )
  process.exit(1)
}

console.log(
  `✔ NC simulate payload mirror: ${CASES.length} triggers + the empty form round-trip through NcTestEventInputSchema with no rejected or dropped field`,
)
