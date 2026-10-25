#!/usr/bin/env tsx
/**
 * D694 — an `object` media read MUST require NcEventMediaScope.
 *
 * The production reader used to list every row of a reused event id when the
 * scope was omitted (compatibility path). That path is closed: absence must
 * refuse, never ship another record's crops. This guard pins the refusal in
 * source so a future edit cannot restore the unscoped listByOwner.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const READER = path.join(
  ROOT,
  'packages/addon-post-analysis/src/pipeline-analytics/nc-owner-media-reader.ts',
)
const src = readFileSync(READER, 'utf8')
const failures: string[] = []

if (!src.includes('NcEventMediaScope required')) {
  failures.push(`${READER}: missing refusal message for an unscoped object read`)
}
if (!src.includes("ownerKind === 'track'")) {
  failures.push(`${READER}: track branch missing — object refusal must not apply to tracks`)
}
// The closed path: listing every object row with no deviceId filter.
if (/listByOwner\(\s*'object'\s*,\s*ownerId\s*\)/.test(src)) {
  failures.push(
    `${READER}: unscoped listByOwner('object', ownerId) is back — that ships every ` +
      'generation of a reused event id (D694 residual)',
  )
}
if (failures.length > 0) {
  console.error('check-object-media-scope-required FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('check-object-media-scope-required: ok')
