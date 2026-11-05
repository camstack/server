#!/usr/bin/env tsx
/**
 * check-no-devices-in-integration-form — an integration's settings form never
 * edits its devices.
 *
 * Devices are added by the Add device modal of the integration page: adopt a
 * candidate found on the network, or enter the parameters of one. A form that
 * lists the devices (an `editable-array` of boards, cameras, hubs…) or imports
 * them (an `importKeys`-style action) is a second, hidden way to add a device:
 * it bypasses the adoption verdicts and cannot be threaded to the integration
 * the device belongs to, and with more than one integration of an addon it
 * writes to a guess.
 *
 * What it reads: the body of every `buildIntegrationFormSchema` /
 * `instanceFormSchema` in `packages/addon-*\/src` (comments stripped). In that
 * body it refuses an `editable-array` field and an `import…` action key.
 *
 * The baseline is empty on purpose: an addon that needs an exception names the
 * file and the reason in `BASELINE`, where a reviewer sees it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface BaselineEntry {
  readonly file: string
  readonly reason: string
}

/** Empty: no integration form edits its devices. */
export const BASELINE: readonly BaselineEntry[] = []

export interface FormFinding {
  readonly line: number
  readonly rule: 'editable-array' | 'import-action'
  readonly text: string
}

const ANCHOR = /\b(?:function\s+buildIntegrationFormSchema|instanceFormSchema)\b/g
const MIN_BODY = 80
const MAX_BODY = 20_000

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** The balanced `{…}` blocks after an anchor, until together they are a real body. */
function bodyAfter(source: string, from: number): { start: number; end: number } | null {
  let cursor = from
  let start = -1
  while (cursor < source.length && cursor - from < MAX_BODY) {
    const open = source.indexOf('{', cursor)
    if (open < 0) return null
    if (start < 0) start = open
    let depth = 0
    let i = open
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (i - start >= MIN_BODY) return { start, end: i }
    cursor = i + 1
  }
  return null
}

export function findDevicesInIntegrationForm(raw: string): readonly FormFinding[] {
  const source = stripComments(raw)
  const found = new Map<string, FormFinding>()
  for (const anchor of source.matchAll(ANCHOR)) {
    const body = bodyAfter(source, anchor.index + anchor[0].length)
    if (body === null) continue
    const text = source.slice(body.start, body.end)
    const rules: ReadonlyArray<readonly [FormFinding['rule'], RegExp]> = [
      ['editable-array', /type\s*:\s*['"]editable-array['"]/g],
      ['import-action', /\b(?:key|id|action)\s*:\s*['"]import[A-Za-z]*['"]/g],
    ]
    for (const [rule, pattern] of rules) {
      for (const hit of text.matchAll(pattern)) {
        const line = source.slice(0, body.start + hit.index).split('\n').length
        found.set(`${rule}:${line}`, { line, rule, text: hit[0] })
      }
    }
  }
  return [...found.values()]
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name) && !/\.(spec|test)\./.test(name)) out.push(full)
  }
}

function main(): void {
  const files: string[] = []
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    if (!pkg.startsWith('addon-')) continue
    const src = path.join(ROOT, 'packages', pkg, 'src')
    if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) walk(src, files)
  }
  const allowed = new Set(BASELINE.map((entry) => entry.file))
  const violations: Array<FormFinding & { readonly file: string }> = []
  for (const full of files) {
    const file = path.relative(ROOT, full).split(path.sep).join('/')
    if (allowed.has(file)) continue
    for (const finding of findDevicesInIntegrationForm(readFileSync(full, 'utf8'))) {
      violations.push({ ...finding, file })
    }
  }
  if (violations.length === 0) {
    console.log(
      `check-no-devices-in-integration-form: OK (${files.length} files, ${BASELINE.length} baselined)`,
    )
    return
  }
  console.error('\n✘ an integration form that edits its devices:\n')
  for (const v of violations) console.error(`    ${v.file}:${v.line}  ${v.rule}  ${v.text}`)
  console.error(
    '\n  Devices are added in the Add device modal (adopt a candidate, or enter its\n' +
      '  parameters through `getCreationSchema` / `createDevice`), never in the settings form.\n',
  )
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
