#!/usr/bin/env tsx
/**
 * Admin and addon pages use the library's form controls, never the browser's.
 *
 * A raw `<select>`, `<input>`, `<textarea>` or `<button>` in a page or widget
 * looks and behaves differently from its neighbours (focus ring, disabled
 * state, search, dark theme) and escapes every fix made to the wrapped
 * primitive. `@camstack/ui-library` owns the wrapped ones (`Select`,
 * `OptionSelect`, `Input`, `Textarea`, `Checkbox`, `Switch`, `Button`, ...),
 * so it is the only place a native element may appear.
 *
 * Scope: `.tsx` under `packages/addon-admin-ui/src` and every
 * `packages/addon-*\/src` (addon pages and widgets), excluding specs and
 * `__tests__`. `packages/ui-library` is out of scope by construction.
 * A justified exception is marked in place with `ui-check-ok: <reason>` on the
 * same or the previous line (the marker `ui:check` already honours).
 *
 * Existing debt is PINNED per file in `scripts/native-form-controls-baseline.json`.
 * A file may not gain an occurrence, and a file that drops below its pin must
 * lower it (`--update`), so an improvement cannot silently come back. Textual:
 * comment-only lines are skipped.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = path.join(ROOT, 'scripts', 'native-form-controls-baseline.json')

const NATIVE = /<(select|textarea|button|input)(?=[\s/>]|$)/g
const SCOPE = /^packages\/(?:addon-admin-ui|addon-[^/]+)\/src\/.*\.tsx$/
const EXEMPT_PATH = /(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:spec|test)\.tsx$/
const OK_MARKER = 'ui-check-ok'

export interface NativeControlFinding {
  readonly line: number
  readonly tag: string
}

/** True for a file the guard looks at. */
export function inScope(file: string): boolean {
  return SCOPE.test(file) && !EXEMPT_PATH.test(file)
}

function isCommentOnly(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** Every native form element in one source text, minus the marked ones. */
export function findNativeControls(source: string): NativeControlFinding[] {
  const lines = source.split('\n')
  const found: NativeControlFinding[] = []
  lines.forEach((text, index) => {
    if (isCommentOnly(text)) return
    for (const match of text.matchAll(NATIVE)) {
      const marked = text.includes(OK_MARKER) || (lines[index - 1] ?? '').includes(OK_MARKER)
      if (!marked) found.push({ line: index + 1, tag: match[1] ?? '' })
    }
  })
  return found
}

export interface PinVerdict {
  readonly worse: readonly string[]
  readonly better: readonly string[]
}

/** Compare today's per-file counts against the pins. */
export function comparePins(
  counts: Readonly<Record<string, number>>,
  pinned: Readonly<Record<string, number>>,
): PinVerdict {
  const worse: string[] = []
  const better: string[] = []
  for (const [file, n] of Object.entries(counts)) {
    const was = pinned[file] ?? 0
    if (n > was) worse.push(`  ${file}: ${was} -> ${n}`)
    if (n < was) better.push(`  ${file}: ${was} -> ${n}`)
  }
  for (const [file, was] of Object.entries(pinned)) {
    if (counts[file] === undefined && was > 0) better.push(`  ${file}: ${was} -> 0`)
  }
  return { worse, better }
}

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'packages/*.tsx'], { cwd: ROOT, encoding: 'utf-8' })
  return out.split('\n').filter((f) => f.length > 0 && inScope(f))
}

function readPins(): Record<string, number> {
  try {
    const parsed: { files?: Record<string, number> } = JSON.parse(readFileSync(BASELINE, 'utf-8'))
    return parsed.files ?? {}
  } catch {
    return {}
  }
}

function main(): void {
  const counts: Record<string, number> = {}
  for (const file of trackedFiles()) {
    const n = findNativeControls(readFileSync(path.join(ROOT, file), 'utf-8')).length
    if (n > 0) counts[file] = n
  }

  if (process.argv.includes('--update')) {
    const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          _comment:
            'Native form controls (select, input, textarea, button) in admin and addon pages. A ratchet: counts only go DOWN. Enforced by scripts/check-no-native-form-controls.ts.',
          files: sorted,
        },
        null,
        2,
      )}\n`,
    )
    console.log(`pinned ${Object.keys(sorted).length} file(s) -> ${path.relative(ROOT, BASELINE)}`)
    return
  }

  const { worse, better } = comparePins(counts, readPins())
  if (worse.length > 0) {
    console.error('FAIL: a native form control was added. Use the library component instead:')
    console.error('  <select> -> Select / OptionSelect, <input> -> Input / Checkbox / Switch,')
    console.error('  <textarea> -> Textarea, <button> -> Button / IconButton.')
    console.error(
      '  (npm run ui:find -- "<need>"; a justified exception carries `ui-check-ok: <why>`.)',
    )
    console.error(worse.join('\n'))
    process.exit(1)
  }
  if (better.length > 0) {
    console.error('Debt went DOWN - lower the pins so it cannot come back:')
    console.error(better.join('\n'))
    console.error('  npx tsx scripts/check-no-native-form-controls.ts --update')
    process.exit(1)
  }
  console.log(`ok native form controls: ${Object.keys(counts).length} pinned file(s), none worse`)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
