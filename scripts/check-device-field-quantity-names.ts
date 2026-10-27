#!/usr/bin/env tsx
/**
 * A device-scoped capability's status field names its QUANTITY, not its unit
 * (`power`, not `watts`; `signal`, not `signalPercent`). The unit is the D944
 * base of the quantity, displayed and converted elsewhere.
 *
 * Allowances live in `scripts/lib/quantity-field-name-allowances.txt`, one per
 * line as `<cap>.<path> -- <reason>`; an entry without a reason, or one that
 * no longer matches a field, fails.
 *
 * Run: npx tsx scripts/check-device-field-quantity-names.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { CapabilityHistory } from '../packages/types/src/capabilities/capability-definition.js'
import { parseAllCaps } from './lib/parse-cap.ts'
import {
  judgeFieldNames,
  parseAllowances,
  staleAllowances,
  type FieldNameCap,
} from './lib/quantity-field-names.ts'

const CAPS_DIR = path.resolve(import.meta.dirname, '../packages/types/src/capabilities')
const ALLOWANCES_PATH = path.resolve(import.meta.dirname, 'lib/quantity-field-name-allowances.txt')

function isHistory(value: unknown): value is CapabilityHistory {
  return value === 'none' || (typeof value === 'object' && value !== null && 'fields' in value)
}

async function loadCaps(): Promise<readonly FieldNameCap[]> {
  const out: FieldNameCap[] = []
  for (const info of parseAllCaps(CAPS_DIR)) {
    const file = info.fileName.replace(/\.js$/, '.ts')
    const mod: Record<string, unknown> = await import(pathToFileURL(path.join(CAPS_DIR, file)).href)
    const def: unknown = mod[info.exportName]
    if (typeof def !== 'object' || def === null) continue
    const record = def as Record<string, unknown>
    const runtimeState = record['runtimeState']
    out.push({
      capName: info.capName,
      scope: info.scope,
      runtimeState: runtimeState instanceof z.ZodType ? runtimeState : undefined,
      history: isHistory(record['history']) ? record['history'] : undefined,
    })
  }
  return out
}

async function main(): Promise<void> {
  const caps = await loadCaps()
  const text = fs.existsSync(ALLOWANCES_PATH) ? fs.readFileSync(ALLOWANCES_PATH, 'utf8') : ''
  const { allowed, errors } = parseAllowances(text)
  const problems = [
    ...errors,
    ...staleAllowances(caps, allowed).map((key) => `stale allowance \`${key}\`: no such field`),
    ...caps.flatMap((cap) =>
      judgeFieldNames(cap, allowed).map(
        (violation) => `${violation.capName}.${violation.path}: ${violation.message}`,
      ),
    ),
  ]
  if (problems.length === 0) {
    process.stdout.write(
      `✔ device field names: ${caps.length} caps checked, ${allowed.size} allowed by reason\n`,
    )
    return
  }
  process.stderr.write('\n\x1b[31m✘ device field quantity names guard failed\x1b[0m\n')
  for (const problem of problems) process.stderr.write(`    - ${problem}\n`)
  process.stderr.write('\n')
  process.exit(1)
}

void main()
