#!/usr/bin/env tsx
/**
 * The `broker` capability is the message bus only (D1013).
 *
 * Which brokers exist, and creating, editing, testing or removing one, is the `integration-instances`
 * provider of the addon that owns them: a broker is an instance whose kind names `functionCap:
 * 'broker'`. So:
 *
 * 1. `broker.cap.ts` declares exactly the bus methods (publish, subscribe, unsubscribe, getState,
 *    getBrokerConfig, getStatus) and no list / add / remove / settings method.
 * 2. `@camstack/types` exports no `BrokerInfo`, `BrokerProviderInfo` or `UnifiedBrokerInfo`: the row
 *    of a broker is an instance row.
 * 3. No addon source (the admin UI only reads kinds, it declares none) implements a provider method `listProviders:` and a `signIn:` declaration sits
 *    only in a source that declares instance kinds (`functionCap:`).
 *
 * Textual: the source is read, not run. Specs, `__tests__`, `dist` and generated code are skipped.
 *
 * Usage: npx tsx scripts/check-broker-cap-is-bus-only.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, type Violation, walk } from './check-integration-instances-declared.ts'

export const BUS_METHODS: readonly string[] = [
  'getBrokerConfig',
  'getState',
  'getStatus',
  'publish',
  'subscribe',
  'unsubscribe',
]

const RETIRED_TYPE_RE = /\b(?:UnifiedBrokerInfo|BrokerProviderInfo|BrokerInfo)\b/
const PROVIDER_METHOD_RE = /\blistProviders\s*:/

/** The method names declared under `methods: {` of the cap definition (four-space keys). */
export function methodNamesOf(capSource: string): string[] {
  const start = capSource.search(/\bmethods:\s*\{/)
  if (start < 0) return []
  const names: string[] = []
  let depth = 0
  for (const line of capSource.slice(start).split('\n')) {
    if (depth === 1) {
      const key = /^\s{4}([A-Za-z]\w*):/.exec(line)
      if (key?.[1] !== undefined) names.push(key[1])
    }
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    if (depth <= 0 && names.length > 0) break
  }
  return names
}

export function findCapViolations(capSource: string, typesIndexSource: string): Violation[] {
  const out: Violation[] = []
  const declared = methodNamesOf(capSource).toSorted()
  const expected = [...BUS_METHODS].toSorted()
  if (declared.join(',') !== expected.join(',')) {
    out.push({
      addon: 'broker.cap.ts',
      message: `declares [${declared.join(', ')}], expected exactly the bus [${expected.join(', ')}]`,
    })
  }
  for (const [name, source] of [
    ['broker.cap.ts', capSource],
    ['capabilities/index.ts', typesIndexSource],
  ] as const) {
    const exported = source
      .split('\n')
      .filter((line) => /\bexport\b|^\s+(?:type\s+)?\w+,?\s*$/.test(line))
      .find((line) => RETIRED_TYPE_RE.test(line) && !/MqttBrokerInfo/.test(line))
    if (exported !== undefined) {
      out.push({
        addon: name,
        message: `exports a retired broker row type (${exported.trim()}): a broker row is an instance row`,
      })
    }
  }
  return out
}

export function findAddonViolations(
  files: ReadonlyArray<{ readonly path: string; readonly source: string }>,
): Violation[] {
  const out: Violation[] = []
  for (const file of files) {
    if (PROVIDER_METHOD_RE.test(file.source)) {
      out.push({
        addon: file.path,
        message: 'implements `listProviders`: the broker kinds are the instance kinds (D1013)',
      })
    }
    if (/\bsignIn\s*:/.test(file.source) && !/\bfunctionCap\s*:/.test(file.source)) {
      out.push({
        addon: file.path,
        message: 'declares `signIn:` outside an instance kind (a kind with `functionCap`)',
      })
    }
  }
  return out
}

function main(): void {
  const cap = readFileSync(
    path.join(ROOT, 'packages/types/src/capabilities/broker.cap.ts'),
    'utf-8',
  )
  const index = readFileSync(path.join(ROOT, 'packages/types/src/capabilities/index.ts'), 'utf-8')
  const files: string[] = []
  const packagesDir = path.join(ROOT, 'packages')
  for (const name of readdirNames(packagesDir)) {
    if (name.startsWith('addon-') && name !== 'addon-admin-ui')
      walk(path.join(packagesDir, name, 'src'), files)
  }
  const violations = [
    ...findCapViolations(cap, index),
    ...findAddonViolations(
      files.map((f) => ({
        path: path.relative(ROOT, f),
        source: readFileSync(f, 'utf-8'),
      })),
    ),
  ]
  if (violations.length === 0) {
    console.log(`check-broker-cap-is-bus-only: broker cap is the bus, ${files.length} sources read`)
    return
  }
  console.error('check-broker-cap-is-bus-only (D1013):')
  for (const v of violations) console.error(`  ${v.addon}: ${v.message}`)
  process.exit(1)
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
