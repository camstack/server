#!/usr/bin/env tsx
/**
 * No tool looks for a specific token file: the `camstack login` session is the credential.
 *
 * ONE token format exists; only the set of permissions differs (admin =
 * everything). Tools that went hunting for `scratchpad/.tok`, a
 * `<host>.admin-token` file or `$CAMSTACK_ADMIN_TOKEN_FILE` each decided on
 * their own which file counted, and a stale one silently won over the session
 * the operator had just logged into. Every hub-talking tool now asks the one
 * resolver (`resolveCredentials` / `resolveFreshCredentials` in
 * `packages/develop/src/hub/`, or `scripts/hub/credentials.mjs` for a script);
 * `--token-file` is an explicit override and names no default path.
 *
 * Scope: `scripts/`, `tests/e2e/` and the CLI / develop / mcp-dev sources,
 * excluding specs and this file. Comment-only lines are skipped. Textual.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const LOOKUP =
  /scratchpad['"`/,\s)]*\.tok\b|['"`]\.tok['"`]|CAMSTACK_ADMIN_TOKEN_FILE|findAdminTokenFile|adminTokenFileForServer|\.admin-token['"`]/

const ROOTS = [
  'scripts',
  'tests/e2e',
  'packages/cli/src',
  'packages/develop/src',
  'packages/mcp-dev/src',
]
const SKIP_DIRS = new Set(['dist', 'node_modules', '__tests__', '__mocks__', 'generated'])
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const NON_RUNTIME_RE = /\.(?:spec|test)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const SELF = 'scripts/check-no-token-file-lookup.ts'

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

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('#')
}

export interface TokenFileFinding {
  readonly file: string
  readonly line: number
  readonly text: string
}

/** Every non-comment line of `source` that names a token-file lookup. */
export function findTokenFileLookups(file: string, source: string): readonly TokenFileFinding[] {
  const found: TokenFileFinding[] = []
  source.split('\n').forEach((text, i) => {
    if (!isCommentLine(text) && LOOKUP.test(text)) {
      found.push({ file, line: i + 1, text: text.trim() })
    }
  })
  return found
}

function main(): number {
  const files: string[] = []
  for (const r of ROOTS) walk(path.join(ROOT, r), files)
  const findings: TokenFileFinding[] = []
  for (const f of files) {
    const rel = path.relative(ROOT, f)
    if (rel === SELF) continue
    findings.push(...findTokenFileLookups(rel, readFileSync(f, 'utf8')))
  }
  if (findings.length === 0) {
    console.log(`check-no-token-file-lookup: ${files.length} files, no token-file lookup`)
    return 0
  }
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.text}`)
  console.error(
    'check-no-token-file-lookup: ask the shared resolver (resolveFreshCredentials / ' +
      'scripts/hub/credentials.mjs); the `camstack login` session is the credential, ' +
      '--token-file is an explicit override with no default path',
  )
  return 1
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main())
}
