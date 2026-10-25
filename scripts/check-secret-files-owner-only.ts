#!/usr/bin/env tsx
/**
 * A secret-bearing file is restricted to its owner through ONE helper.
 *
 * `mode: 0o600` and `chmod 0o600` restrict nothing on Windows (Node maps them
 * to the read-only attribute), so an `agent.json` written that way would hold
 * the mesh private key readable by every local user of a
 * Windows agent. `@camstack/types/node`'s `writeOwnerOnlyFileSync` /
 * `restrictFileToOwnerSync` do the POSIX chmod AND an owner+SYSTEM `icacls` ACL
 * on Windows; a new secret-bearing write goes through them.
 *
 * This guard refuses a bare `0o600` in runtime source. The files below are the
 * ones where it is deliberate — each is NOT a secret held by a node that can
 * run on Windows, or is not a secret at all — and each says why. Adding to the
 * list is a decision, so it needs a reason, not a shrug.
 *
 * Scope: `packages/<pkg>/src` and `server/backend/src`, excluding specs,
 * `__tests__` and generated code. Comment-only lines are skipped. Textual.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const OWNER_ONLY_MODE = /\b0o600\b/

export const ALLOWED: Readonly<Record<string, string>> = {
  'packages/types/src/util/owner-only-file.ts': 'the helper itself: the POSIX half of the rule',
  'packages/develop/src/hub/session-store.ts':
    'the operator CLI on their own machine, in their home directory — not an agent',
  'packages/mcp-dev/src/ops/download.ts':
    'a developer tool downloading to the operator machine — not a node',
  'packages/system/src/builtins/system-backup/backup-encryption.ts':
    'hub-only: an encrypted archive; the key never lands in this file',
  'packages/system/src/builtins/system-backup/system-backup.service.ts':
    'hub-only: the backup archive and its database snapshot (streamed, large)',
  'packages/system/src/kernel/addon-manifest.ts':
    'tidy, not secret: addon install state, rewritten on a hot path (one icacls per write is a process spawn)',
  'packages/system/src/kernel/lifecycle/job-journal.ts':
    'tidy, not secret: job state, rewritten on a hot path (one icacls per write is a process spawn)',
}

const SKIP_DIRS = new Set([
  'dist',
  'node_modules',
  '.git',
  'coverage',
  'generated',
  '__tests__',
  '__mocks__',
])
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const NON_RUNTIME_RE = /\.(?:spec|test|d)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

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
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

function runtimeRoots(): string[] {
  const roots = [path.join(ROOT, 'server/backend/src')]
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    roots.push(path.join(ROOT, 'packages', pkg, 'src'))
  }
  return roots
}

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export interface OwnerOnlyFinding {
  readonly file: string
  readonly line: number
  readonly text: string
}

export function findBareOwnerOnlyModes(
  files: readonly { readonly rel: string; readonly content: string }[],
): OwnerOnlyFinding[] {
  const findings: OwnerOnlyFinding[] = []
  for (const { rel, content } of files) {
    if (rel in ALLOWED) continue
    for (const [i, text] of content.split('\n').entries()) {
      if (isCommentLine(text)) continue
      if (OWNER_ONLY_MODE.test(text)) findings.push({ file: rel, line: i + 1, text: text.trim() })
    }
  }
  return findings
}

function main(): void {
  const paths: string[] = []
  for (const root of runtimeRoots()) walk(root, paths)
  const files = paths.map((p) => ({
    rel: path.relative(ROOT, p).split(path.sep).join('/'),
    content: readFileSync(p, 'utf-8'),
  }))
  const findings = findBareOwnerOnlyModes(files)
  if (findings.length === 0) {
    console.log(`check-secret-files-owner-only: ${files.length} runtime files, no bare 0o600`)
    return
  }
  console.error(
    'check-secret-files-owner-only: 0o600 restricts nothing on Windows — write a secret with ' +
      "writeOwnerOnlyFileSync / restrictFileToOwnerSync from '@camstack/types/node':",
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
