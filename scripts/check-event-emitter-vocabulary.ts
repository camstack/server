#!/usr/bin/env tsx
/**
 * Every `event-emitter` provider declares its event vocabulary (D1044).
 *
 * A rule, the events page and the notification picker name an event from the
 * device's `vocabulary`. A provider that leaves it out, or writes it empty,
 * gives the operator a device that fires events nobody can pick.
 *
 * Scope: runtime source under `packages/<pkg>/src` outside `packages/types`,
 * excluding specs and generated code. A file is checked when it names
 * `eventEmitterCapability`. Textual:
 *  - it must write a `vocabulary:` property;
 *  - it must not write the literal `vocabulary: []`, unless the file is listed
 *    in `OPEN_VOCABULARY` with the reason its source declares nothing.
 * A listed file that no longer writes an empty vocabulary is refused too, so
 * the list cannot outlive its reason.
 *
 * Not covered: a vocabulary computed from a list that is empty at run time
 * (an entity whose integration announces no event types).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIRS = new Set(['dist', 'node_modules', '.git', 'coverage', 'generated', '__tests__'])
const SOURCE_RE = /\.tsx?$/
const NON_RUNTIME_RE = /\.(spec|test|d)\.tsx?$/

/** Sources whose events have no declared set, each with the reason. */
export const OPEN_VOCABULARY: Readonly<Record<string, string>> = {
  'packages/addon-provider-homeassistant/src/devices/ha-event-bus-device.ts':
    'a raw bus event type (a device trigger relayed by the bus) announces no set of events',
}

export type VocabularyProblem = 'no-vocabulary' | 'empty-vocabulary' | 'stale-exception'

export interface SourceFile {
  readonly rel: string
  readonly content: string
}

export interface VocabularyFinding {
  readonly file: string
  readonly line: number
  readonly problem: VocabularyProblem
}

const CAP_RE = /\beventEmitterCapability\b/
const WRITE_RE = /\bvocabulary\s*:/
const EMPTY_RE = /\bvocabulary\s*:\s*\[\s*\]/

function emptyLines(content: string): number[] {
  const lines = content.split('\n')
  return lines.flatMap((line, index) => (EMPTY_RE.test(line) ? [index + 1] : []))
}

export function findVocabularyFindings(
  files: readonly SourceFile[],
  open: Readonly<Record<string, string>>,
): VocabularyFinding[] {
  const findings: VocabularyFinding[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (!CAP_RE.test(file.content)) continue
    seen.add(file.rel)
    const empties = emptyLines(file.content)
    const listed = open[file.rel] !== undefined
    if (listed) {
      if (empties.length === 0)
        findings.push({ file: file.rel, line: 1, problem: 'stale-exception' })
      continue
    }
    if (!WRITE_RE.test(file.content)) {
      findings.push({ file: file.rel, line: 1, problem: 'no-vocabulary' })
      continue
    }
    for (const line of empties) findings.push({ file: file.rel, line, problem: 'empty-vocabulary' })
  }
  for (const rel of Object.keys(open)) {
    if (!seen.has(rel)) findings.push({ file: rel, line: 1, problem: 'stale-exception' })
  }
  return findings
}

const EXPLAIN: Readonly<Record<VocabularyProblem, string>> = {
  'no-vocabulary': 'names eventEmitterCapability and never writes `vocabulary:`',
  'empty-vocabulary': 'writes `vocabulary: []` (declare the events, or list the file as open)',
  'stale-exception': 'is listed in OPEN_VOCABULARY and no longer writes an empty vocabulary',
}

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

function main(): void {
  const paths: string[] = []
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    if (pkg === 'types') continue
    walk(path.join(ROOT, 'packages', pkg, 'src'), paths)
  }
  const files = paths.map((p) => ({
    rel: path.relative(ROOT, p).split(path.sep).join('/'),
    content: readFileSync(p, 'utf-8'),
  }))
  const findings = findVocabularyFindings(files, OPEN_VOCABULARY)
  if (findings.length === 0) {
    const providers = files.filter((f) => CAP_RE.test(f.content)).length
    console.log(
      `check-event-emitter-vocabulary: ${providers} provider file(s), each declares its vocabulary`,
    )
    return
  }
  console.error('check-event-emitter-vocabulary: an event-emitter provider without a vocabulary:')
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${EXPLAIN[f.problem]}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
