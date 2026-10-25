/**
 * THE GUARD against native browser dialogs in the admin UI.
 *
 * ## The failure it pins
 *
 * Operator report: Identity → Users reset a password through `window.prompt`.
 * A native prompt **cannot mask its input**, so a new password was typed in
 * clear text into a box the browser may offer to remember. The sweep that
 * followed found eight more sites — confirms for irreversible deletes, alerts
 * for server failures, and one prompt used as a clipboard fallback — none of
 * which match the product's visual language, and none of which the host can
 * style or test.
 *
 * Every one of them is now served by the ONE dialog provider in
 * `@camstack/ui-library` (`useConfirm` / `useAlert` / `usePrompt`). This file
 * is what stops the next one coming back: a rule nothing checks has already
 * been broken somewhere.
 *
 * ## Why a SOURCE scan and not a render test
 *
 * The mistake is reaching for a GLOBAL. A render test proves one dialog path
 * works; it cannot prove that no other file calls `window.confirm`. jsdom, for
 * its part, defines `window.confirm` as a no-op returning `false` and never
 * throws — so a native call in production code passes every existing suite in
 * silence. Scanning the sources is the only check that sees all of it.
 *
 * ## Why bare `confirm(...)` needs a binding check
 *
 * `confirm` is BOTH a global and this repo's established local name for
 * `useConfirm()` — some forty files do `const confirm = useConfirm()`. So a
 * bare call is an offence only when the file does not bind the name itself
 * (the since-deleted Cluster Templates tab was exactly that: a bare `confirm(...)` with no
 * binding, hitting the global). `alert` and `prompt` are never bound to the
 * global's name by our convention (`showAlert` / `showPrompt`), so a bare call
 * there is flagged unless the file binds it too — the same rule, uniformly
 * applied.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(import.meta.dirname, '..')

/** The three globals no admin-ui source may reach for. */
const NATIVE_DIALOGS: readonly string[] = ['prompt', 'confirm', 'alert']

/** This guard names the forbidden calls in prose; it may not scan itself. */
const SELF = 'no-native-dialogs.spec.ts'

interface SourceFile {
  readonly path: string
  readonly text: string
}

function collectSources(dir: string): SourceFile[] {
  const out: SourceFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      out.push(...collectSources(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (entry.name === SELF) continue
    out.push({ path: relative(SRC_DIR, full), text: readFileSync(full, 'utf8') })
  }
  return out
}

/**
 * Strips comments and quoted strings, so that prose about the rule and data
 * that merely MENTIONS a dialog are not offences. `parseLoginRedirect(
 * 'javascript:alert(1)')` and the i18n default `'System prompt (optional)'`
 * both looked like calls until this ran.
 *
 * Template literals are deliberately left intact: their `${…}` holes are real
 * code, and a guard that over-reports fails loudly where one that under-reports
 * fails silently.
 */
function stripNonCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
}

/** Does this file declare its own `name`, shadowing the global? */
function bindsLocally(text: string, name: string): boolean {
  return new RegExp(`(?:const|let|var|function)\\s+${name}\\b`).test(text)
}

function offencesIn(file: SourceFile): string[] {
  const code = stripNonCode(file.text)
  const found: string[] = []
  for (const name of NATIVE_DIALOGS) {
    const qualified = new RegExp(`\\b(?:window|globalThis|self)\\.${name}\\s*\\(`, 'g')
    for (const _m of code.matchAll(qualified)) found.push(`${file.path}: window.${name}(`)
    if (bindsLocally(code, name)) continue
    // A bare call, in a file that never declares the name → the global.
    const bare = new RegExp(`(?<![.\\w$])${name}\\s*\\(`, 'g')
    for (const _m of code.matchAll(bare)) found.push(`${file.path}: bare ${name}(`)
  }
  return found
}

describe('admin UI has no native browser dialogs', () => {
  const sources = collectSources(SRC_DIR)

  // A guard that matches nothing guards nothing. These two assertions fail if
  // the scan is ever pointed at the wrong directory or silently finds no files.
  it('finds the admin UI sources it is meant to scan', () => {
    expect(sources.length).toBeGreaterThan(200)
    const paths = sources.map((s) => s.path)
    expect(paths).toContain(join('pages', 'system', 'Users.tsx'))
    expect(paths).toContain(join('components', 'detection-intelligence', 'CopyUrlChips.tsx'))
  })

  it('can recognise a native dialog call when it sees one', () => {
    const offences = offencesIn({
      path: 'fixture.tsx',
      text: [
        "const a = window.prompt('New password:')",
        "window.alert('nope')",
        "if (confirm('really?')) drop()",
      ].join('\n'),
    })
    expect(offences).toEqual([
      'fixture.tsx: window.prompt(',
      'fixture.tsx: bare confirm(',
      'fixture.tsx: window.alert(',
    ])
  })

  it('does not flag a dialog name that only appears inside a string', () => {
    const offences = offencesIn({
      path: 'fixture.tsx',
      text: [
        "expect(parse('javascript:alert(1)')).toBeNull()",
        "t('ai.systemPrompt', 'System prompt (optional)')",
      ].join('\n'),
    })
    expect(offences).toEqual([])
  })

  it('does not flag the repo convention of `const confirm = useConfirm()`', () => {
    const offences = offencesIn({
      path: 'fixture.tsx',
      text: ['const confirm = useConfirm()', "const ok = await confirm({ title: 't' })"].join('\n'),
    })
    expect(offences).toEqual([])
  })

  it('calls no window.prompt / window.confirm / window.alert', () => {
    const offences = sources.flatMap(offencesIn)
    expect(
      offences,
      offences.length === 0
        ? ''
        : `Native browser dialogs found. Use useConfirm / useAlert / usePrompt from @camstack/ui-library instead:\n  ${offences.join('\n  ')}`,
    ).toEqual([])
  })
})
