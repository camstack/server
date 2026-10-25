#!/usr/bin/env tsx
/**
 * A secret that lives in a business row is written to the keychain by its
 * owner and nowhere else (D878).
 *
 * ## The failure this catches
 *
 * Two secrets sat in plain text in SQLite while every other credential was in
 * the keychain: an LLM profile's `apiKey` (`ai:llm-profiles`) and a user's TOTP
 * seed (`user_totp.secret`). Both rows are written by ONE owner file, which now
 * stores a keychain marker and resolves it on read. A second writer (a new
 * route, a script, a "quick" import) would put the plaintext back, and no type
 * says so.
 *
 * ## The rules
 *
 *  - `owner-writes-marker` - the registered owner file still builds the marker
 *    (`makeSecretMarker`) and stores the value with `.put(`. A row that moved to
 *    `ctx.records` has no such code: the kind's schema marks the field
 *    `.meta({ secret: true })` and the records facade writes the marker, so its
 *    owner file is the kind declaration and `ownerNeeds` names that.
 *  - `single-writer` - no other non-test source under `packages/` or `server/`
 *    names the collection. The collection constant is exported for the owner's
 *    own schema declaration only; everything else reaches the rows through the
 *    owner's capability.
 *
 * Usage: npx tsx scripts/check-keychain-backed-rows.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface BackedRow {
  readonly collection: string
  /** The identifiers/literals that name the collection in source. */
  readonly names: readonly string[]
  /** Files allowed to name it; the first one is the writer. */
  readonly files: readonly string[]
  /** What the writer file must contain; default: the marker builder and `.put(`. */
  readonly ownerNeeds?: readonly string[]
}

export const BACKED_ROWS: readonly BackedRow[] = [
  {
    collection: 'ai:llm-profiles',
    names: ['PROFILES_COLLECTION', "'ai:llm-profiles'", '"ai:llm-profiles"'],
    // Records phase 2: the kind declares the secret, the store only reads/writes the kind.
    files: ['packages/addon-ai/src/record-kinds.ts', 'packages/addon-ai/src/profile-store.ts'],
    ownerNeeds: ['.meta({ secret: true })'],
  },
  {
    collection: 'user_totp',
    names: ['USER_TOTP_COLLECTION', 'TOTP_COLLECTION', "'user_totp'", '"user_totp"'],
    files: [
      'packages/system/src/auth/totp-manager.ts',
      'packages/system/src/builtins/local-auth/auth-schema.ts',
      'packages/system/src/builtins/local-auth/record-kinds.ts',
    ],
  },
]

export interface Finding {
  readonly file: string
  readonly line: number
  readonly rule: 'owner-writes-marker' | 'single-writer'
  readonly text: string
}

// `camstack-data` is a local runtime data dir (installed addons, media) and
// dot-dirs hold agent worktrees: walking them made the scan take 25 s.
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '__tests__',
  'generated',
  'camstack-data',
])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.(spec|test)\./.test(name)) out.push(full)
  }
  return out
}

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export function scan(root: string): Finding[] {
  const findings: Finding[] = []
  const files: string[] = []
  for (const top of ['packages', 'server']) {
    const dir = join(root, top)
    if (existsSync(dir)) sourceFiles(dir, files)
  }
  for (const row of BACKED_ROWS) {
    const owner = row.files[0]
    if (owner !== undefined) {
      const path = join(root, owner)
      const text = existsSync(path) ? readFileSync(path, 'utf-8') : ''
      for (const needed of row.ownerNeeds ?? ['makeSecretMarker', '.put(']) {
        if (!text.includes(needed)) {
          findings.push({
            file: owner,
            line: 1,
            rule: 'owner-writes-marker',
            text: `${row.collection}: owner no longer uses \`${needed}\``,
          })
        }
      }
    }
    for (const file of files) {
      const rel = relative(root, file)
      if (row.files.includes(rel)) continue
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          if (isComment(line)) return
          if (row.names.some((n) => line.includes(n))) {
            findings.push({ file: rel, line: i + 1, rule: 'single-writer', text: line.trim() })
          }
        })
    }
  }
  return findings
}

function main(): void {
  const findings = scan(process.cwd())
  if (findings.length === 0) {
    console.log('✔ keychain-backed rows are written by their owner only')
    return
  }
  for (const f of findings) {
    console.error(`✘ ${f.file}:${f.line} [${f.rule}] ${f.text}`)
  }
  console.error(
    '\nThe apiKey of an LLM profile and a TOTP seed are keychain secrets; only the owner file writes their rows (D878).',
  )
  process.exit(1)
}

if (process.argv[1]?.endsWith('check-keychain-backed-rows.ts')) main()
