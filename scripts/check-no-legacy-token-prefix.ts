#!/usr/bin/env tsx
/**
 * No source names a pre-D892 opaque token format (D895).
 *
 * There is ONE token format — a JWT minted by `auth.mintToken`, whose
 * permissions are its scopes. The three opaque formats it replaced (the admin,
 * scoped and share-view prefixes: `cs` + `a_` / `t_` / `v_`) authenticate
 * nobody, and nothing mints, reads, classifies or documents them any more. A
 * literal of one in code is a prefix check coming back, a test fixture that
 * makes a dead format look alive, or a comment describing a path that no
 * longer exists — all three are how a removed credential path returns.
 *
 * The allowlist is EMPTY. A spec that must send such a bearer (to prove it is
 * refused) spells it from parts, as `legacy-bearer-refused.spec.ts` does.
 *
 * The refresh token (`csr_`) is NOT one of them: it is never a bearer — only
 * `auth.refreshSession` accepts it, as an input, to renew a login session.
 *
 * Scope: every git-tracked TypeScript / JavaScript / shell source, comments
 * included. Out of scope: prose (`*.md`, `docs/`), release notes (JSON), the
 * viewer submodule (its own repository) and built bundles under `assets/`.
 * Textual.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The three retired prefixes, built from parts so this file never carries one. */
const LEGACY_PREFIX = new RegExp(`(?<![A-Za-z0-9_$])c${'s'}(?:a|t|v)_`)

const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|sh)$/
/** Built output that is not authored here (the viewer web bundle is built from `camstack/`). */
const BUILT_RE = /(?:^|\/)(?:dist|assets)\//

/** The files every allowance would name. Empty by decision (D895): add nothing. */
export const ALLOWED_FILES: readonly string[] = []

export interface LegacyPrefixFinding {
  readonly file: string
  readonly line: number
  readonly text: string
}

/** Every line of `source` that names a retired token prefix. */
export function findLegacyTokenPrefixes(
  file: string,
  source: string,
): readonly LegacyPrefixFinding[] {
  const found: LegacyPrefixFinding[] = []
  source.split('\n').forEach((text, i) => {
    if (LEGACY_PREFIX.test(text)) found.push({ file, line: i + 1, text: text.trim() })
  })
  return found
}

/** Is a tracked path one this guard reads? */
export function inScope(file: string): boolean {
  return SOURCE_RE.test(file) && !BUILT_RE.test(file) && !ALLOWED_FILES.includes(file)
}

function trackedFiles(): readonly string[] {
  const patterns = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'sh'].map((e) => `*.${e}`)
  const out = execFileSync('git', ['ls-files', '-z', '--', ...patterns], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter((f) => f !== '')
}

function main(): number {
  const files = trackedFiles().filter(inScope)
  const findings: LegacyPrefixFinding[] = []
  for (const rel of files) {
    let source: string
    try {
      source = readFileSync(path.join(ROOT, rel), 'utf8')
    } catch {
      continue // tracked but deleted in the working tree
    }
    findings.push(...findLegacyTokenPrefixes(rel, source))
  }
  if (findings.length === 0) {
    console.log(`check-no-legacy-token-prefix: ${files.length} files, no retired token prefix`)
    return 0
  }
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.text}`)
  console.error(
    'check-no-legacy-token-prefix: the pre-D892 opaque token formats are gone (D895) — ' +
      'there is one token, minted by auth.mintToken. Remove the prefix; a spec that must ' +
      'send one to prove it is refused spells it from parts.',
  )
  return 1
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main())
}
