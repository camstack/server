#!/usr/bin/env tsx
/**
 * One create door for an instance (planning#440, D1013 rule 1).
 *
 * `integration-instances.createInstance` is the only way to make an instance or an integration:
 * an operator creates through it, and an addon or the hub seeds the integration it owns through its
 * `seed` variant. The retired `integrations.create` was a second door beside it, and a second door
 * is where the connection-test gate, the rollback and the stamp check get skipped.
 *
 * This refuses
 * 1. the retired door by name in product source: `integrations.create`, `useIntegrationsCreate`;
 * 2. a `create…` method on the `integrations` cap, and any other cap that declares a method named
 *    `createInstance` or `createIntegration` (the one that stays is `integration-instances.cap.ts`).
 *
 * Textual: the source is read, not run. Specs, `__tests__`, generated code, changelogs and docs are
 * skipped (a spec may name the retired door to say it is gone).
 *
 * Usage: npx tsx scripts/check-one-instance-create-door.ts
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RETIRED_RE = /\bintegrations\.create\b|\buseIntegrationsCreate\b/
const METHOD_RE = /^\s{2,4}(create\w*)\s*:\s*(?:optionalMethod|method)\s*\(/
const SOLE_OWNER = 'integration-instances.cap.ts'

export interface SourceFile {
  /** Repo-relative, forward slashes. */
  readonly path: string
  readonly text: string
}

export interface Violation {
  readonly where: string
  readonly message: string
}

function isProductSource(file: string): boolean {
  if (!/\.(ts|tsx|mjs)$/.test(file)) return false
  if (file.startsWith('docs/') || file.includes('/generated/')) return false
  if (file.includes('/__tests__/') || /\.(spec|test)\.[tj]sx?$/.test(file)) return false
  if (file.includes('/dist/') || file.includes('/assets/')) return false
  return file !== 'scripts/check-one-instance-create-door.ts'
}

export function findViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = []
  for (const file of files) {
    if (isProductSource(file.path)) {
      file.text.split('\n').forEach((line, index) => {
        if (RETIRED_RE.test(line)) {
          out.push({
            where: `${file.path}:${index + 1}`,
            message:
              'names the retired `integrations.create`. Create through `integrationInstances.createInstance` (an addon seeding its own integration passes `seed`).',
          })
        }
      })
    }
    if (!file.path.endsWith('.cap.ts')) continue
    const base = file.path.slice(file.path.lastIndexOf('/') + 1)
    for (const line of file.text.split('\n')) {
      const name = METHOD_RE.exec(line)?.[1]
      if (name === undefined) continue
      const secondDoor =
        (base === 'integrations.cap.ts' && name.startsWith('create')) ||
        (base !== SOLE_OWNER && (name === 'createInstance' || name === 'createIntegration'))
      if (secondDoor) {
        out.push({
          where: file.path,
          message: `${name}: a second create door. \`integration-instances.createInstance\` is the only one.`,
        })
      }
    }
  }
  return out
}

function main(): number {
  const names = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((f) => f !== '')
  const files: SourceFile[] = names.map((f) => ({
    path: f,
    text: readFileSync(path.join(ROOT, f), 'utf8'),
  }))
  const violations = findViolations(files)
  for (const v of violations) console.error(`check-one-instance-create-door: ${v.where}: ${v.message}`)
  if (violations.length === 0) console.log('check-one-instance-create-door: OK')
  return violations.length === 0 ? 0 : 1
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main())
}
