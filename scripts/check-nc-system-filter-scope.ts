#!/usr/bin/env tsx
/**
 * System-event filter-scope guard — the ENGINE narrows exactly what the EDITOR
 * says it narrows.
 *
 * ## The failure this catches
 *
 * A `system-event` rule carries optional narrowing filters beside its
 * required `kinds` gate: `deviceIds`, `deviceTypes`, `nodeIds`, `packageNames`,
 * and (D642) the consumable threshold `consumableLowPercent`.
 * Each belongs to a FAMILY of kinds — a node going away has no device type, a
 * finished export has no package, `stream-offline` deliberately carries no
 * device type — and the rule editors have always known that: they compute which
 * filter inputs to RENDER from exactly this scoping, and hide the rest.
 *
 * The engine did not. It applied all four to every kind, so a filter from one
 * family failed a kind from another family CLOSED. The operator's live rule
 * "Eventi di sistema" selected eleven kinds and set `deviceTypes: ['camera']` —
 * the only way to say "only my cameras" about the two liveness kinds — and nine
 * of the eleven silently became undeliverable. Four days of history held 66
 * `device-online`, 69 `device-offline`, and not one node, stream, update or
 * export event, through a window in which agents were restarted and addons were
 * updated. Nothing logged, nothing failed, and the editor kept showing the rule
 * as covering eleven kinds.
 *
 * Two surfaces computing the same scoping, one of them silently, is not a thing
 * review catches. Hence a check.
 *
 * ## What it checks
 *
 * 1. BEHAVIOUR, for every (kind × filter) pair — 3 answers must agree:
 *      - `systemEventFilterApplies` (the single source, `@camstack/types`),
 *      - the admin UI's `systemEventFilterVisibility` for that one kind,
 *      - the ENGINE, observed: a rule that sets ONLY that filter, against a
 *        subject carrying NO identity at all. If the engine applies the filter
 *        it cannot be satisfied and the subject is excluded; if it scopes the
 *        filter out, the subject matches. There is no third outcome. The one
 *        fact the probe subject does carry is the consumable threshold it was
 *        judged at — the DEFAULT, which is not an identity but a judgement
 *        every consumable subject has (D642): a rule that states no threshold
 *        agrees with it, so only the threshold probe itself can disagree.
 *    It runs the real `evaluateRule`, not a reading of it.
 * 2. An APPLIED filter must NAME itself (`excludedBySystemEventFilter`), or the
 *    legitimate drop goes back to being silent — which is how the four-day
 *    outage stayed invisible.
 * 3. Neither reader may hand-roll the family predicate again: the `device-` /
 *    `stream-` / `node-` / `update-available` string tests may appear in the
 *    owner module and nowhere else — the hub's family validator
 *    (`rule-family-guard.ts`) included.
 * 4. FAMILIES (D637), three answers that must agree per (family × filter):
 *      - every authorable kind has exactly one family, and every legacy kind
 *        has none;
 *      - the family filter table (`NC_SYSTEM_EVENT_FAMILY_FILTERS`) lists a base
 *        filter exactly when the per-kind scoping applies it to some kind of
 *        the family;
 *      - the HUB VALIDATOR (`systemEventFamilyProblems`, which
 *        `rule-family-guard.ts` runs on every create/update) refuses a filter
 *        exactly when the table forbids it — observed, on a one-kind probe;
 *      - neither editor's per-family visibility — the admin's
 *        `systemEventFilterVisibilityFor`, the viewer's `familyFilterVisibility`
 *        — ever SHOWS a filter the hub would refuse (a box the operator fills
 *        and the save rejects). The viewer is probed with the family's own
 *        kinds, each kind alone, and with every authorable kind at once (a
 *        stray selection must not grow a foreign box either).
 *
 * The viewer (`camstack/`) is a submodule: CI checks out without it. When it
 * is absent the viewer halves of 3 and 4 are SKIPPED and the output says so —
 * "I could not look" and "it is fine" are different answers (D315); the
 * precedent is `check-nc-mirrors-in-sync.ts`. The viewer module resolves
 * `@camstack/types` from `camstack/node_modules` (the PUBLISHED release the
 * app ships with), which is exactly the copy whose tables it must agree with.
 *
 * Usage: npx tsx scripts/check-nc-system-filter-scope.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  NcRule,
  NcSystemEventCondition,
  NcSystemEventConditionFilterKey,
  NcSystemEventFilterKey,
  NcSystemEventKind,
} from '@camstack/types'
import {
  NC_CONSUMABLE_LOW_PERCENT_DEFAULT,
  NC_SYSTEM_EVENT_CONDITION_FILTER_KEYS,
  NC_SYSTEM_EVENT_FAMILIES,
  NC_SYSTEM_EVENT_FAMILY,
  NC_SYSTEM_EVENT_FAMILY_FILTERS,
  NC_SYSTEM_EVENT_FILTER_KEYS,
  systemEventFamilyProblems,
  systemEventFilterApplies,
  systemEventKindsOfFamily,
} from '@camstack/types'
import {
  type NcSystemEventFamilyFilterVisibility,
  type NcSystemEventFilterVisibility,
  systemEventFilterVisibility,
  systemEventFilterVisibilityFor,
} from '../packages/addon-admin-ui/src/pages/system/notification-system-events.js'
import type { NcFamilyFilterVisibility } from '../camstack/src/components/notifications/system-event-family.js'
import {
  evaluateRule,
  NC_SYSTEM_DEVICE_ID,
  type NcRuleSubject,
} from '../packages/addon-post-analysis/src/notification-center/rule-engine.js'
import {
  NC_AUTHORABLE_SYSTEM_EVENT_KINDS,
  NcSystemEventKindSchema,
} from '../packages/types/src/capabilities/notification-rules.cap.js'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The viewer's family editor module — in the `camstack/` submodule. */
const VIEWER_FAMILY_FILE = 'camstack/src/components/notifications/system-event-family.ts'
const viewerPresent = fs.existsSync(path.join(ROOT, VIEWER_FAMILY_FILE))

/** The one module allowed to state which filter is about which kind. */
const OWNER_FILE = 'packages/types/src/notification/system-event-filters.ts'

/**
 * The readers. Each consumed the scoping by re-deriving it; neither may again.
 * The engine is listed even though it never had a copy — it had the OPPOSITE
 * bug (no scoping at all), and a hand-rolled predicate is exactly how a future
 * session would "fix" a new kind without touching the owner.
 */
const READER_FILES: readonly string[] = [
  'packages/addon-admin-ui/src/pages/system/notification-system-events.ts',
  'packages/addon-post-analysis/src/notification-center/rule-engine.ts',
  'packages/addon-post-analysis/src/notification-center/rule-family-guard.ts',
  VIEWER_FAMILY_FILE,
]

/** The family tests. Present in the owner; a copy anywhere else is the drift. */
const FAMILY_PREDICATES: readonly string[] = [
  "startsWith('device-')",
  "startsWith('stream-')",
  "startsWith('node-')",
  "endsWith('update-available')",
]

/** The editor names its filters after the INPUT it renders; the engine after
 *  the condition FIELD. One translation, stated once. */
const VISIBILITY_KEY: Readonly<
  Record<NcSystemEventFilterKey, keyof NcSystemEventFilterVisibility>
> = {
  deviceIds: 'devices',
  deviceTypes: 'deviceTypes',
  nodeIds: 'nodes',
  packageNames: 'packages',
  consumableLowPercent: 'consumableThreshold',
}

/** A filter's value in a probe rule: a list, or the threshold number. */
type ProbeFilterValue = readonly number[] | readonly string[] | number

/**
 * A value per filter that NO subject below can satisfy — the subject carries no
 * identity at all, so an APPLIED filter always excludes and a SCOPED-OUT filter
 * always matches. That is what makes the engine's answer readable as a boolean.
 */
const UNSATISFIABLE: Readonly<Record<NcSystemEventFilterKey, ProbeFilterValue>> = {
  deviceIds: [-1],
  deviceTypes: ['a-type-no-device-has'],
  nodeIds: ['a-node-that-does-not-exist'],
  packageNames: ['@camstack/never-installed'],
  // Any threshold but the one the probe subject was judged at (the default).
  consumableLowPercent: NC_CONSUMABLE_LOW_PERCENT_DEFAULT + 1,
}

const BASE_RULE: NcRule = {
  id: 'guard-rule',
  name: 'guard',
  enabled: true,
  disabledTargetIds: [],
  delivery: 'system-event',
  conditions: {},
  targets: [{ targetId: 't' }],
  media: { attach: 'none' },
  throttle: { cooldownSec: 60, scope: 'rule-device' },
  priority: 3,
  createdBy: 'guard',
  createdAt: 0,
  updatedAt: 0,
}

function ruleFor(kind: NcSystemEventKind, filter: NcSystemEventFilterKey): NcRule {
  return {
    ...BASE_RULE,
    conditions: { systemEvent: { kinds: [kind], [filter]: UNSATISFIABLE[filter] } },
  }
}

/**
 * A subject with the kind and NO identity — no device, node or package. It
 * carries the consumable threshold it was judged at, the DEFAULT (see the
 * header): a judgement, not an identity.
 */
function bareSubject(kind: NcSystemEventKind): NcRuleSubject {
  return {
    kind: 'system-event',
    recordId: `guard-${kind}`,
    deviceId: NC_SYSTEM_DEVICE_ID,
    timestamp: 1_000,
    classNames: [],
    zones: [],
    systemEvent: {
      kind,
      subject: `system:${kind}`,
      consumableLowPercent: NC_CONSUMABLE_LOW_PERCENT_DEFAULT,
      data: {},
    },
  }
}

/** A one-kind condition that sets exactly `filter`, with a well-formed value. */
function probeCondition(
  kind: NcSystemEventKind,
  filter: NcSystemEventConditionFilterKey,
): NcSystemEventCondition {
  switch (filter) {
    case 'deviceIds':
      return { kinds: [kind], deviceIds: [1] }
    case 'excludeDeviceIds':
      return { kinds: [kind], excludeDeviceIds: [1] }
    case 'deviceTypes':
      return { kinds: [kind], deviceTypes: ['camera'] }
    case 'nodeIds':
      return { kinds: [kind], nodeIds: ['hub'] }
    case 'packageNames':
      return { kinds: [kind], packageNames: ['@camstack/server'] }
    case 'consumableLowPercent':
      return { kinds: [kind], consumableLowPercent: 25 }
  }
}

/** The admin family editor's boxes, and the condition field each one writes. */
const FAMILY_BOXES = [
  'devices',
  'excludeDevices',
  'deviceTypes',
  'nodes',
  'packages',
  'consumableThreshold',
] as const satisfies readonly (keyof NcSystemEventFamilyFilterVisibility)[]

const FAMILY_BOX_FILTER: Readonly<
  Record<(typeof FAMILY_BOXES)[number], NcSystemEventConditionFilterKey>
> = {
  devices: 'deviceIds',
  excludeDevices: 'excludeDeviceIds',
  deviceTypes: 'deviceTypes',
  nodes: 'nodeIds',
  packages: 'packageNames',
  consumableThreshold: 'consumableLowPercent',
}

/** The viewer family editor's boxes, and the condition field each one writes. */
const VIEWER_BOX_FILTER: Readonly<
  Record<keyof NcFamilyFilterVisibility, NcSystemEventConditionFilterKey>
> = {
  devices: 'deviceIds',
  excludeDevices: 'excludeDeviceIds',
  deviceTypes: 'deviceTypes',
  nodes: 'nodeIds',
  packages: 'packageNames',
  consumableThreshold: 'consumableLowPercent',
}
const VIEWER_BOXES = [
  'devices',
  'excludeDevices',
  'deviceTypes',
  'nodes',
  'packages',
  'consumableThreshold',
] as const satisfies readonly (keyof NcFamilyFilterVisibility)[]

const problems: string[] = []
const notes: string[] = []

// ── 1 + 2. Behaviour, per (kind × filter) ─────────────────────────────────
for (const kind of NcSystemEventKindSchema.options) {
  for (const filter of NC_SYSTEM_EVENT_FILTER_KEYS) {
    const declared = systemEventFilterApplies(kind, filter)
    const editorShows = systemEventFilterVisibility([kind])[VISIBILITY_KEY[filter]]
    const evaluation = evaluateRule(ruleFor(kind, filter), bareSubject(kind))
    const engineApplies = !evaluation.matched
    if (editorShows !== declared) {
      problems.push(
        `${kind} × ${filter}: the editor ${editorShows ? 'SHOWS' : 'HIDES'} this filter but ` +
          `systemEventFilterApplies says ${declared} — the editor must derive from it`,
      )
    }
    if (engineApplies !== declared) {
      problems.push(
        `${kind} × ${filter}: the engine ${engineApplies ? 'APPLIES' : 'IGNORES'} this filter but ` +
          `systemEventFilterApplies says ${declared}` +
          (engineApplies
            ? ' — an out-of-family filter must be IGNORED, never fail closed (this is the bug that' +
              ' starved nine of the eleven kinds on the live rule)'
            : ' — an in-family filter that narrows nothing is a filter the operator cannot use'),
      )
    }
    if (engineApplies && evaluation.excludedBySystemEventFilter !== filter) {
      problems.push(
        `${kind} × ${filter}: the engine excluded the subject without naming the filter ` +
          `(excludedBySystemEventFilter = ${String(evaluation.excludedBySystemEventFilter)}) — ` +
          'the caller cannot log a drop it cannot name',
      )
    }
  }
}

// ── 3. No second author ───────────────────────────────────────────────────
for (const file of READER_FILES) {
  if (file === VIEWER_FAMILY_FILE && !viewerPresent) continue
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
  for (const predicate of FAMILY_PREDICATES) {
    if (source.includes(predicate)) {
      problems.push(
        `${file}: hand-rolls the family test \`${predicate}\` — the scoping lives in ` +
          `${OWNER_FILE}; call systemEventFilterApplies / systemEventFilterAppliesToAnyKind`,
      )
    }
  }
}
if (!fs.existsSync(path.join(ROOT, OWNER_FILE))) {
  problems.push(`${OWNER_FILE} is missing — the single source of the scoping has been deleted`)
}

// ── 4. Families (D637): every kind in exactly one family; the family filter
//      table agrees with the per-kind scoping; the hub validator refuses
//      exactly what the table forbids; the admin never shows a refused box. ──
for (const kind of NcSystemEventKindSchema.options) {
  const family = NC_SYSTEM_EVENT_FAMILY[kind]
  const authorable = NC_AUTHORABLE_SYSTEM_EVENT_KINDS.includes(kind)
  if (authorable && family === null) problems.push(`${kind}: authorable but has no family`)
  if (!authorable && family !== null) problems.push(`${kind}: legacy but has a family (${family})`)
}
for (const family of NC_SYSTEM_EVENT_FAMILIES) {
  const kinds = systemEventKindsOfFamily(family)
  const tabledFilters = NC_SYSTEM_EVENT_FAMILY_FILTERS[family]
  const [first] = kinds
  if (first === undefined) {
    problems.push(`${family}: no kinds — a family nobody can author`)
    continue
  }
  for (const filter of NC_SYSTEM_EVENT_FILTER_KEYS) {
    const derived = kinds.some((k) => systemEventFilterApplies(k, filter))
    const tabled = tabledFilters.includes(filter)
    if (derived !== tabled) {
      problems.push(
        `${family} × ${filter}: the family table says ${String(tabled)}, the per-kind scoping ` +
          `says ${String(derived)} — NC_SYSTEM_EVENT_FAMILY_FILTERS must be the union of ` +
          'systemEventFilterApplies over the family',
      )
    }
  }
  for (const filter of NC_SYSTEM_EVENT_CONDITION_FILTER_KEYS) {
    const refused = systemEventFamilyProblems(probeCondition(first, filter)).some(
      (p) => p.code === 'filter-outside-family' && p.filter === filter,
    )
    if (refused === tabledFilters.includes(filter)) {
      problems.push(
        `${family} × ${filter}: the hub validator ${refused ? 'REFUSES' : 'ACCEPTS'} this filter ` +
          `against the family table (which ${refused ? 'allows' : 'forbids'} it)`,
      )
    }
  }
  // The admin's per-family visibility never shows a filter the hub would refuse.
  const shown = systemEventFilterVisibilityFor(family, kinds)
  for (const box of FAMILY_BOXES) {
    const filter = FAMILY_BOX_FILTER[box]
    if (shown[box] && !tabledFilters.includes(filter)) {
      problems.push(
        `${family}: the admin shows the ${box} box but the hub refuses ${filter} on every ${family} rule`,
      )
    }
  }
}

// ── 4b. The viewer's per-family visibility, against the hub validator. ──────
/** One set of kinds the viewer's family visibility is probed with. */
interface ViewerProbeSelection {
  readonly label: string
  readonly kinds: readonly NcSystemEventKind[]
}

// A DYNAMIC import: the module exists only when the submodule is checked out.
async function checkViewerFamilyVisibility(): Promise<void> {
  if (!viewerPresent) {
    notes.push(
      '⊘ viewer NOT checked: the camstack/ submodule is not checked out here — run ' +
        '`git submodule update --init camstack` to check its family visibility and predicate scan',
    )
    return
  }
  const viewer = await import('../camstack/src/components/notifications/system-event-family.js')
  let probes = 0
  for (const family of NC_SYSTEM_EVENT_FAMILIES) {
    const kinds = systemEventKindsOfFamily(family)
    const [first] = kinds
    if (first === undefined) continue
    const selections: readonly ViewerProbeSelection[] = [
      { label: `every ${family} kind`, kinds },
      ...kinds.map((kind) => ({ label: kind, kinds: [kind] })),
      {
        label: 'every authorable kind (a stray selection)',
        kinds: NC_AUTHORABLE_SYSTEM_EVENT_KINDS,
      },
    ]
    for (const selection of selections) {
      const shown = viewer.familyFilterVisibility(family, selection.kinds)
      for (const box of VIEWER_BOXES) {
        probes++
        if (!shown[box]) continue
        const filter = VIEWER_BOX_FILTER[box]
        // OBSERVED, not read off the table: the probe the hub validator judges.
        const refused = systemEventFamilyProblems(probeCondition(first, filter)).some(
          (p) => p.code === 'filter-outside-family' && p.filter === filter,
        )
        if (refused) {
          problems.push(
            `${family}: the viewer shows the ${box} box for ${selection.label} but the hub ` +
              `refuses ${filter} on every ${family} rule (${VIEWER_FAMILY_FILE})`,
          )
        }
      }
    }
  }
  notes.push(`✓ viewer: ${String(probes)} family-visibility probes agree with the hub validator`)
}

function report(): void {
  if (problems.length > 0) {
    console.error('✗ notification-rules system-event filter scope has drifted:\n')
    for (const problem of problems) console.error(`  · ${problem}`)
    console.error(
      `\n${problems.length} problem(s). The scoping is stated once, in ${OWNER_FILE}, and the` +
        ' engine and every editor read it. See `system-event-filter-scope.spec.ts`.',
    )
    process.exit(1)
  }

  console.log(
    `✓ system-event filter scope: engine and editor agree on all ` +
      `${NcSystemEventKindSchema.options.length * NC_SYSTEM_EVENT_FILTER_KEYS.length} (kind × filter) pairs, ` +
      `and all ${NC_SYSTEM_EVENT_FAMILIES.length} families agree with the hub validator`,
  )
  for (const note of notes) console.log(`  ${note}`)
}

checkViewerFamilyVisibility().then(report, (error: unknown) => {
  console.error('✗ notification-rules system-event filter scope: the viewer probe could not run')
  console.error(error)
  process.exit(1)
})
