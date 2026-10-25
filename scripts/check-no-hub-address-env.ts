#!/usr/bin/env tsx
/**
 * No runtime code reads the hub's address from the environment.
 *
 * `CAMSTACK_HUB_PUBLIC_URL` (and its older alias `CAMSTACK_PUBLIC_ORIGIN`)
 * restated what the `local-network` capability owns — the hub's interfaces,
 * listen port, allowlist, tunnel and mesh, edited on the admin Network page.
 * Because the variable was optional (and the desktop app has no field for
 * it), a hub without it handed agents `https://127.0.0.1:4443` and every addon
 * and model pull to an agent failed. Every reader now goes through
 * `localNetwork.getAddresses().roles` (one resolver per role).
 *
 * The only file that may still NAME the variables is the boot step that warns
 * they are ignored and strips them from the environment before any runner is
 * forked (`retired-public-url-env.ts`). Specs may name them to prove they are
 * ignored.
 *
 * Scope: runtime source — `packages/<pkg>/src` and `server/backend/src`,
 * excluding specs, `__tests__` and generated code. Comment-only lines are
 * skipped (prose may name the variable to explain its removal). Textual: a
 * name assembled at runtime passes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RETIRED = /\bCAMSTACK_(?:HUB_PUBLIC_URL|PUBLIC_ORIGIN)\b/

/** The one file that names them: to warn and strip, never to read a value. */
const ALLOWED = new Set(['server/backend/src/boot/retired-public-url-env.ts'])

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

/** A line that is only comment — prose may name the variable to explain its removal. */
function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export interface HubAddressEnvFinding {
  readonly file: string
  readonly line: number
  readonly text: string
}

export function findHubAddressEnvReads(
  files: readonly { readonly rel: string; readonly content: string }[],
): HubAddressEnvFinding[] {
  const findings: HubAddressEnvFinding[] = []
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
  const findings = findHubAddressEnvReads(files)
  if (findings.length === 0) {
    console.log(`check-no-hub-address-env: ${files.length} runtime files, none name the variable`)
    return
  }
  console.error(
    'check-no-hub-address-env: the hub address comes from the local-network capability ' +
      '(getAddresses().roles), never from CAMSTACK_HUB_PUBLIC_URL / CAMSTACK_PUBLIC_ORIGIN:',
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
