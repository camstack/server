#!/usr/bin/env tsx
/**
 * No runtime code reads `config.yaml` (D1018, planning #342).
 *
 * The bootstrap config is built-in defaults plus `CAMSTACK_PORT`,
 * `CAMSTACK_HOST` and `CAMSTACK_DATA`; everything a yaml once carried lives in
 * the keychain (master key at `/run/secrets/camstack-master-key`, D991), the
 * settings store or a capability. The one-release transition reader was
 * removed 2026-11-12. This guard keeps a second bootstrap source from coming
 * back: no runtime file names `config.yaml` / `config.yml` or the old
 * `CONFIG_PATH` variable.
 *
 * The only file that may still name it is the restore step that SKIPS the
 * entry when an older backup archive carries it (`pending-restore.ts`). Specs
 * may name it to prove it is ignored.
 *
 * Scope: runtime source — `packages/<pkg>/src` and `server/backend/src`,
 * excluding specs, `__tests__` and generated code. Comment-only lines are
 * skipped (prose may name the file to explain its removal). Textual: a name
 * assembled at runtime passes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RETIRED = /\bconfig\.ya?ml\b|\bCONFIG_PATH\b/

/** The one file that names it: to skip it in an older archive, never to read it. */
const ALLOWED = new Set(['server/backend/src/pending-restore.ts'])

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

/** A line that is only comment — prose may name the file to explain its removal. */
function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export interface ConfigYamlFinding {
  readonly file: string
  readonly line: number
  readonly text: string
}

export function findConfigYamlReads(
  files: readonly { readonly rel: string; readonly content: string }[],
): ConfigYamlFinding[] {
  const findings: ConfigYamlFinding[] = []
  for (const { rel, content } of files) {
    if (ALLOWED.has(rel)) continue
    for (const [i, text] of content.split('\n').entries()) {
      if (isCommentLine(text)) continue
      if (RETIRED.test(text)) findings.push({ file: rel, line: i + 1, text: text.trim() })
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
  const findings = findConfigYamlReads(files)
  if (findings.length === 0) {
    console.log(`check-no-config-yaml: ${files.length} runtime files, none read config.yaml`)
    return
  }
  console.error(
    'check-no-config-yaml: there is no config.yaml (D1018) — bootstrap values come from ' +
      'CAMSTACK_PORT / CAMSTACK_HOST / CAMSTACK_DATA, everything else from the keychain, settings or a capability:',
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
