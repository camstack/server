#!/usr/bin/env tsx
/**
 * No device-controls hero card draws the device's electrical draw itself (D1004).
 *
 * The `power-meter` capability declares a hero widget (`host/power-meter-line`)
 * that every device bound to it shows under its hero card. A hero card that
 * also read the `power-meter` slice drew the watts a second time, in its own
 * look, and only for its own device type (a heater, an appliance, a media
 * player), so the same plug read differently from one device to the next.
 *
 * Scope: `packages/ui-library/src/composites/device-controls/` and the admin-ui
 * hero cards (`packages/addon-admin-ui/src/components/device/hero/`) runtime files.
 * The two files that serve a SENSOR device — whose reading IS the device —
 * are the only ones that may read the slice. Comment-only lines are skipped.
 * Textual: a name assembled at runtime passes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = 'packages/ui-library/src/composites/device-controls'
const HERO_DIRS = [DIR, 'packages/addon-admin-ui/src/components/device/hero']

/** A sensor device's own reading: the sensor hero resolves its source slice here. */
const ALLOWED = new Set([`${DIR}/sensor-hero-source.ts`, `${DIR}/sensor-value-atom.tsx`])

const POWER_READ = /\bpowerMeter\b|['"]power-meter['"]/
const SOURCE_RE = /\.(?:ts|tsx)$/
const NON_RUNTIME_RE = /\.(?:spec|test|d)\.(?:ts|tsx)$/

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export interface SelfDrawnPowerFinding {
  readonly file: string
  readonly line: number
  readonly text: string
}

export function findSelfDrawnPower(
  files: readonly { readonly rel: string; readonly content: string }[],
): SelfDrawnPowerFinding[] {
  const findings: SelfDrawnPowerFinding[] = []
  for (const { rel, content } of files) {
    if (ALLOWED.has(rel)) continue
    for (const [i, text] of content.split('\n').entries()) {
      if (isCommentLine(text)) continue
      if (POWER_READ.test(text)) findings.push({ file: rel, line: i + 1, text: text.trim() })
    }
  }
  return findings
}

function main(): void {
  const paths: string[] = []
  for (const d of HERO_DIRS) walk(path.join(ROOT, d), paths)
  const files = paths.map((p) => ({
    rel: path.relative(ROOT, p).split(path.sep).join('/'),
    content: readFileSync(p, 'utf-8'),
  }))
  const findings = findSelfDrawnPower(files)
  if (findings.length === 0) {
    console.log(`check-no-hero-self-drawn-power: ${files.length} files, none read power-meter`)
    return
  }
  console.error(
    'check-no-hero-self-drawn-power: the power draw is the power-meter cap hero widget ' +
      '(host/power-meter-line), never drawn by a device-controls card:',
  )
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.text}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
