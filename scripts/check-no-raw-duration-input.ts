#!/usr/bin/env tsx
/**
 * A duration is typed through ONE component, `DurationInput` (#661).
 *
 * The operator's rule: a duration lets the person type in the units they think
 * in (h, m, s, ms), and the stored value never changes with the units shown.
 * Two things break that, and this guard refuses both in the admin UI and the
 * ui-library:
 *
 * 1. an import or a use of a retired duration component (`DurationPartsInput`,
 *    `DurationValueInput`, `DelayField`, `NumberSecondsField`, `useDurationLabels`);
 * 2. a number `<input>` / `<Input>` whose name, label, id, test id or text key
 *    says seconds, minutes, hours, ms, duration, interval, delay or timeout.
 *
 * `DurationInput` itself is exempt (it is the number fields). A deliberate
 * exception (a count that merely shares a word, a value that is not a
 * duration) carries `duration-input-ok: <reason>` on the element's first line
 * or the line above it. Textual: a name assembled at runtime passes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['packages/addon-admin-ui/src', 'packages/ui-library/src']

/** The one file allowed to render the number fields of a duration. */
const EXEMPT = new Set(['packages/ui-library/src/composites/duration-input/DurationInput.tsx'])

/**
 * Time-of-day and scheduler surfaces (point editor, scheduler editor): their
 * minutes are offsets and grace windows of a schedule, migrated with the
 * time-window components in a later phase of #661, not here.
 */
const SCHEDULER_DIRS = ['packages/addon-admin-ui/src/pages/build/schedulers/']

const RETIRED =
  /\b(DurationPartsInput|DurationValueInput|DelayField|NumberSecondsField|useDurationLabels)\b/
const NUMBER_TYPE = /\btype=(?:"number"|\{\s*['"]number['"]\s*\})/
const DURATION_WORD =
  /second|minute|hour|millis|duration|interval|delay|timeout|\bms\b|[-_.]ms\b|[a-z]Ms\b/i
const ATTR_NAMES = ['aria-label', 'label', 'id', 'name', 'data-testid', 'placeholder', 'title']
const OK_MARK = 'duration-input-ok:'
const SOURCE_RE = /\.(?:ts|tsx)$/
const NON_RUNTIME_RE = /\.(?:spec|test|d)\.(?:ts|tsx)$/

export interface RawDurationFinding {
  readonly file: string
  readonly line: number
  readonly kind: 'retired-component' | 'number-input'
  readonly text: string
}

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

/** The attribute values of one element that name the field: quoted strings, `t('key')` and template text. */
function nameText(element: string): string {
  const out: string[] = []
  for (const attr of ATTR_NAMES) {
    const re = new RegExp(`(?:^|\\s)${attr}=(?:"([^"]*)"|\\{([^}]*)\\})`, 'g')
    for (const m of element.matchAll(re)) out.push(m[1] ?? m[2] ?? '')
  }
  return out.join(' ')
}

export function findRawDurationInputs(
  files: readonly { readonly rel: string; readonly content: string }[],
): RawDurationFinding[] {
  const findings: RawDurationFinding[] = []
  for (const { rel, content } of files) {
    if (EXEMPT.has(rel) || SCHEDULER_DIRS.some((dir) => rel.startsWith(dir))) continue
    const lines = content.split('\n')
    for (const [i, text] of lines.entries()) {
      if (isCommentLine(text)) continue
      if (RETIRED.test(text) && !text.includes(OK_MARK)) {
        findings.push({ file: rel, line: i + 1, kind: 'retired-component', text: text.trim() })
      }
      if (!/<(?:Input|input|DraftNumberInput)\b/.test(text)) continue
      let end = i
      while (end < lines.length - 1 && !/\/>|<\/(?:Input|input)>/.test(lines[end] ?? '')) end++
      const element = lines.slice(i, end + 1).join('\n')
      if (!NUMBER_TYPE.test(element) && !/<DraftNumberInput\b/.test(text)) continue
      const marked = text.includes(OK_MARK) || (lines[i - 1] ?? '').includes(OK_MARK)
      if (marked || !DURATION_WORD.test(nameText(element))) continue
      findings.push({ file: rel, line: i + 1, kind: 'number-input', text: text.trim() })
    }
  }
  return findings
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

function main(): void {
  const paths: string[] = []
  for (const d of DIRS) walk(path.join(ROOT, d), paths)
  const files = paths.map((p) => ({
    rel: path.relative(ROOT, p).split(path.sep).join('/'),
    content: readFileSync(p, 'utf-8'),
  }))
  const findings = findRawDurationInputs(files)
  if (findings.length === 0) {
    console.log(
      `check-no-raw-duration-input: ${files.length} files, every duration is a DurationInput`,
    )
    return
  }
  console.error(
    'check-no-raw-duration-input: a duration is `DurationInput` (h / min / s / ms, the stored unit named by the caller), ' +
      `never a retired component or a bare number field. A false positive carries \`${OK_MARK} <reason>\`:`,
  )
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.kind}]  ${f.text}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
