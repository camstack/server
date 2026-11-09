#!/usr/bin/env tsx
/**
 * The notification centre runs Actions; it does not execute steps (planning#473, D1025).
 *
 * ## The failure this catches
 *
 * The centre once carried its own copy of the Actions vocabulary — a step schema, a
 * shared-sequence store and an executor — beside the real Actions surface. Two
 * authoring places meant two behaviours for "what happens when a rule fires": one had
 * a throttle, the other did not, one survived a device removal, the other did not.
 * A rule or a button now names an Action by id and `actions.run` does the rest; this
 * keeps the second copy from growing back "just for this one case".
 *
 * ## What it checks
 *
 * Under `packages/addon-post-analysis/src/notification-center` (tests included):
 *  - the retired modules (`sequence-store`) and identifiers (`NcRuleActionSchema`,
 *    `NcSharedSequence`, `sequenceActionsOf`, `listSequences`...) do not reappear;
 *  - nothing imports a STEP vocabulary (`ActionStepSchema`, `AutomationCapStepSchema`,
 *    `normalizeCapStep`, `ActionTargetSchema`) — the centre may read the steps of an
 *    Action to ask whether it presses the alarm panel (a TYPE import), never to run them.
 * The two files that read the OLD stored shape to carry it forward are listed below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const NC_DIR = path.join(ROOT, 'packages/addon-post-analysis/src/notification-center')

/** Files that read the pre-#473 stored shape on purpose. */
const LEGACY_READERS = new Set(['record-kinds.ts', 'rule-legacy-actions.ts', 'device-prune-ledger.ts'])

const RETIRED_IDENTIFIERS = [
  'NcRuleActionSchema',
  'NcSharedSequence',
  'NcActionBinding',
  'NcHookBindings',
  'sequenceActionsOf',
  'listSequences',
  'createSequence',
  'updateSequence',
  'deleteSequence',
  'NcSequenceGrant',
  'runGrantedSequence',
]

const STEP_VOCABULARY = [
  'ActionStepSchema',
  'AutomationCapStepSchema',
  'AutomationWaitStepSchema',
  'normalizeCapStep',
  'ActionTargetSchema',
]

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sources(full))
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const failures: string[] = []
for (const file of sources(NC_DIR)) {
  const base = path.basename(file)
  const rel = path.relative(ROOT, file)
  if (base === 'sequence-store.ts') failures.push(`${rel}: the shared-sequence store is retired`)
  if (LEGACY_READERS.has(base)) continue
  const text = readFileSync(file, 'utf8')
  for (const id of [...RETIRED_IDENTIFIERS, ...STEP_VOCABULARY]) {
    if (new RegExp(`\\b${id}\\b`).test(text)) {
      failures.push(`${rel}: names ${id} — the centre runs Actions by id, it has no step vocabulary`)
    }
  }
}

if (failures.length > 0) {
  console.error('check-nc-no-executor: the notification centre grew an executor again')
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log('check-nc-no-executor: ok')
