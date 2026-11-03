#!/usr/bin/env tsx
/**
 * One caller of `createComposition` outside tests (D1004).
 *
 * A composed device is created naked in one place and grows through Customize.
 * The admin UI reaches the `core-blocks.createComposition` cap method through
 * the generated hook `useCoreBlocksCreateComposition`; exactly one file may do
 * so (`lib/create-composition.ts`, exporting `useCreateComposition`), and every
 * creation surface calls that. A second caller is a second creation path that
 * can drift (a template, a preset, a type-specific shortcut).
 * Server side: the cap handler and the store are the implementation, not callers.
 * Textual; generated files, specs and `dist` are skipped.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = [
  'packages/addon-admin-ui/src',
  'packages/ui-library/src',
  'server',
  'packages/sdk/src',
]
export const THE_CALLER = 'packages/addon-admin-ui/src/lib/create-composition.ts'

const CALL_RE =
  /\buseCoreBlocksCreateComposition\b|\.createComposition\s*\(|createComposition\.(?:mutate|useMutation|mutateAsync)/
const SOURCE_RE = /\.(?:ts|tsx)$/
const SKIP_FILE_RE = /\.(?:spec|test|d)\.(?:ts|tsx)$|generated/
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'generated', 'assets'])

function walk(dir: string, out: string[]): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name) && !SKIP_FILE_RE.test(name)) out.push(full)
  }
}

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export function callersOf(
  files: readonly { readonly rel: string; readonly content: string }[],
): string[] {
  return files
    .filter(({ content }) => content.split('\n').some((l) => !isCommentLine(l) && CALL_RE.test(l)))
    .map(({ rel }) => rel)
}

export function checkSingleCaller(callers: readonly string[]): string[] {
  const problems: string[] = []
  for (const c of callers) {
    if (c !== THE_CALLER)
      problems.push(
        `${c} reaches createComposition itself; call useCreateComposition from lib/create-composition instead`,
      )
  }
  if (!callers.includes(THE_CALLER))
    problems.push(`${THE_CALLER} no longer calls createComposition`)
  return problems
}

function main(): void {
  const paths: string[] = []
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), paths)
  const files = paths.map((p) => ({
    rel: path.relative(ROOT, p).split(path.sep).join('/'),
    content: readFileSync(p, 'utf-8'),
  }))
  const problems = checkSingleCaller(callersOf(files))
  if (problems.length === 0) {
    console.log(
      `check-single-composition-creator: ${files.length} files, one caller (${THE_CALLER})`,
    )
    return
  }
  for (const p of problems) console.error(`check-single-composition-creator: ${p}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
