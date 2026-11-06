#!/usr/bin/env tsx
/**
 * One switch per instance (planning#440 step 3, D996, D1007).
 *
 * `integration-instances.setInstanceEnabled` is the only way to switch an instance on or off. The
 * switch is ONE stored field (the record body's `enabled`, read through `isInstanceEnabled`); a
 * registry flag is a projection, never a second store. Two rules:
 *
 * 1. A capability method named `set…Enabled` whose input is not device-scoped (no `deviceId`: a
 *    device switch is D62's, not an instance's) is a second switch. The only one allowed is
 *    `integration-instances.setInstanceEnabled`; the others are the committed baseline
 *    `scripts/one-row-switch-baseline.json` (`capMethods`), each with the reason it cannot move
 *    yet. The baseline only shrinks.
 * 2. A provider of `integration-instances` does not implement `setInstanceEnabled` itself: the
 *    helper `RecordIntegrationInstances` (and `composeInstanceKinds` over it) is the one
 *    implementation. A file outside them that defines one is in the baseline
 *    (`setInstanceEnabledImplementations`) or refused.
 *
 * Textual: the source is read, not run. Specs, `__tests__`, `dist` and generated code are skipped.
 *
 * Usage: npx tsx scripts/check-one-row-switch.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CAP_METHOD_RE = /^\s{2,4}(set\w*Enabled)\s*:\s*(?:optionalMethod|method)\s*\(/
const NEXT_METHOD_RE = /^\s{2,4}\w+\s*:\s*(?:optionalMethod|method)\s*\(/
const HELPER_FILES: ReadonlySet<string> = new Set([
  'packages/types/src/addon/record-integration-instances.ts',
  'packages/types/src/addon/compose-instance-kinds.ts',
])
const ALLOWED_CAP_METHOD = 'integration-instances.cap.ts:setInstanceEnabled'
const IMPL_RE = /\bsetInstanceEnabled\s*(?::\s*(?:async\b|\(|IIntegration)|\(\s*(?:input|\{))/
const DEVICE_SCOPED_RE = /\bdeviceId\b/

export interface Baseline {
  readonly capMethods: Readonly<Record<string, string>>
  readonly setInstanceEnabledImplementations: Readonly<Record<string, string>>
}

export interface SourceFile {
  /** Repo-relative, forward slashes. */
  readonly path: string
  readonly text: string
}

export interface Violation {
  readonly where: string
  readonly message: string
}

/** The method declarations `set…Enabled: method(` of one cap file, with the input they take. */
export function switchMethodsOf(text: string): { name: string; deviceScoped: boolean }[] {
  const lines = text.split('\n')
  const out: { name: string; deviceScoped: boolean }[] = []
  lines.forEach((line, index) => {
    const m = CAP_METHOD_RE.exec(line)
    if (m?.[1] === undefined) return
    // The input schema sits in the next few lines, up to the next method declaration.
    const window = lines.slice(index + 1, index + 5)
    const stop = window.findIndex((next) => NEXT_METHOD_RE.test(next))
    const head = [line, ...(stop === -1 ? window : window.slice(0, stop))].join('\n')
    out.push({ name: m[1], deviceScoped: DEVICE_SCOPED_RE.test(head) })
  })
  return out
}

export function findViolations(
  caps: readonly SourceFile[],
  sources: readonly SourceFile[],
  baseline: Baseline,
): Violation[] {
  const out: Violation[] = []
  const seenCap = new Set<string>()
  for (const cap of caps) {
    const base = cap.path.slice(cap.path.lastIndexOf('/') + 1)
    for (const method of switchMethodsOf(cap.text)) {
      if (method.deviceScoped) continue
      const key = `${base}:${method.name}`
      seenCap.add(key)
      if (key === ALLOWED_CAP_METHOD) continue
      if (baseline.capMethods[key] === undefined) {
        out.push({
          where: cap.path,
          message: `${method.name}: a second way to switch an instance. Use integration-instances.setInstanceEnabled; a row that is not an instance record yet is listed (with its reason) in scripts/one-row-switch-baseline.json`,
        })
      }
    }
  }
  for (const key of Object.keys(baseline.capMethods)) {
    if (!seenCap.has(key)) {
      out.push({
        where: 'scripts/one-row-switch-baseline.json',
        message: `capMethods lists "${key}" but no such method exists: remove the line`,
      })
    }
  }
  const seenImpl = new Set<string>()
  for (const source of sources) {
    if (HELPER_FILES.has(source.path)) continue
    if (!IMPL_RE.test(source.text)) continue
    seenImpl.add(source.path)
    if (baseline.setInstanceEnabledImplementations[source.path] === undefined) {
      out.push({
        where: source.path,
        message:
          'implements setInstanceEnabled itself: the switch is RecordIntegrationInstances.setInstanceEnabled (one stored field, one reader isInstanceEnabled)',
      })
    }
  }
  for (const file of Object.keys(baseline.setInstanceEnabledImplementations)) {
    if (!seenImpl.has(file)) {
      out.push({
        where: 'scripts/one-row-switch-baseline.json',
        message: `setInstanceEnabledImplementations lists "${file}" which no longer implements it: remove the line`,
      })
    }
  }
  return out
}

function walk(dir: string, accept: (file: string) => boolean, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (
      name === 'node_modules' ||
      name === 'dist' ||
      name === '__tests__' ||
      name === 'generated'
    ) {
      continue
    }
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, accept, out)
    else if (accept(full)) out.push(full)
  }
}

function read(files: readonly string[]): SourceFile[] {
  return files.map((file) => ({
    path: path.relative(ROOT, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }))
}

function main(): number {
  const capFiles: string[] = []
  walk(path.join(ROOT, 'packages/types/src/capabilities'), (f) => f.endsWith('.cap.ts'), capFiles)
  const srcFiles: string[] = []
  const skip = (f: string): boolean =>
    f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts') && !f.endsWith('.cap.ts')
  walk(path.join(ROOT, 'packages'), skip, srcFiles)
  const baseline: Baseline = JSON.parse(
    readFileSync(path.join(ROOT, 'scripts/one-row-switch-baseline.json'), 'utf8'),
  )
  const violations = findViolations(read(capFiles), read(srcFiles), baseline)
  for (const v of violations) console.error(`check-one-row-switch: ${v.where}: ${v.message}`)
  if (violations.length === 0) console.log('check-one-row-switch: OK')
  return violations.length === 0 ? 0 : 1
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main())
}
