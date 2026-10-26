#!/usr/bin/env tsx
/**
 * D944 §4 — device state has no root `unit` / `precision` / `*Unit` sibling,
 * and every device-native numeric reading names a quantity (or is listed in
 * the debt file until it is classified).
 *
 * Run: npx tsx scripts/check-no-state-unit-sibling.ts
 *      npx tsx scripts/check-no-state-unit-sibling.ts --print-unclassified
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { CapabilityHistory } from '../packages/types/src/capabilities/capability-definition.js'
import { parseAllCaps } from './lib/parse-cap.ts'
import {
  judgeStateUnits,
  unclassifiedQuantities,
  type StateUnitCap,
} from './lib/state-unit-sibling.ts'

const CAPS_DIR = path.resolve(import.meta.dirname, '../packages/types/src/capabilities')
const DEBT_PATH = path.resolve(import.meta.dirname, 'lib/quantity-debt.txt')

function readDebt(): Set<string> {
  if (!fs.existsSync(DEBT_PATH)) return new Set()
  const lines = fs
    .readFileSync(DEBT_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  return new Set(lines)
}

function isHistory(value: unknown): value is CapabilityHistory {
  return value === 'none' || (typeof value === 'object' && value !== null && 'fields' in value)
}

async function loadCaps(): Promise<readonly StateUnitCap[]> {
  const out: StateUnitCap[] = []
  for (const info of parseAllCaps(CAPS_DIR)) {
    const file = info.fileName.replace(/\.js$/, '.ts')
    const mod: Record<string, unknown> = await import(pathToFileURL(path.join(CAPS_DIR, file)).href)
    const def: unknown = mod[info.exportName]
    if (typeof def !== 'object' || def === null) continue
    const record = def as Record<string, unknown>
    const runtimeState = record['runtimeState']
    if (!(runtimeState instanceof z.ZodType)) continue
    const history = isHistory(record['history']) ? record['history'] : undefined
    out.push({
      capName: info.capName,
      scope: info.scope,
      deviceNative: record['deviceNative'] === true,
      runtimeState,
      history,
    })
  }
  return out
}

async function main(): Promise<void> {
  const caps = await loadCaps()
  if (process.argv.includes('--print-unclassified')) {
    const lines = caps.flatMap((cap) => unclassifiedQuantities(cap)).toSorted()
    process.stdout.write(`${lines.join('\n')}\n`)
    return
  }
  const debt = readDebt()
  const violations = caps.flatMap((cap) => judgeStateUnits(cap, debt))
  if (violations.length === 0) {
    process.stdout.write(
      `✔ state units: ${caps.length} device schemas, ${debt.size} quantities still unclassified\n`,
    )
    return
  }
  process.stderr.write('\n\x1b[31m✘ state unit sibling guard failed\x1b[0m\n')
  for (const violation of violations) {
    process.stderr.write(
      `    - ${violation.capName}.${violation.path} [${violation.rule}] ${violation.message}\n`,
    )
  }
  process.stderr.write('\n')
  process.exit(1)
}

void main()
