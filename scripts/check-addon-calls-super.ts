#!/usr/bin/env tsx
/**
 * Every concrete addon class calls `super(...)` from its own constructor.
 *
 * `BaseAddon` keeps the config it is constructed with. A subclass with no
 * constructor hands it `undefined`, and the first `Object.keys(config)` during
 * initialisation throws "Cannot convert undefined or null to object" — on the
 * real node only, because specs build the addon through fakes. The loader then
 * logs "Core builtin failed to initialize -- skipping" and the capability has
 * no provider. It cost the `display-palette` release on 2026-10-25, and the
 * same trap had been hit before by a vendor addon.
 *
 * Scope: runtime source under `packages/<pkg>/src` and `server/backend/src`,
 * excluding specs and generated code. A class is checked when it is declared
 * `class X extends BaseAddon` (with or without type arguments) and is not
 * `abstract`. Textual: the class body must contain a `constructor(` whose body
 * calls `super(`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIRS = new Set([
  'dist',
  'node_modules',
  '.git',
  'coverage',
  'generated',
  '__tests__',
  '__mocks__',
])
const SOURCE_RE = /\.(?:ts|tsx|mts)$/
const NON_RUNTIME_RE = /\.(?:spec|test|d)\.(?:ts|tsx|mts)$/
const CLASS_RE =
  /^(\s*)(export\s+)?(default\s+)?(abstract\s+)?class\s+(\w+)\s+extends\s+BaseAddon\b/

export interface AddonSuperFinding {
  readonly file: string
  readonly line: number
  readonly className: string
}

/** The class body from the opening brace after `start` to its matching close. */
function classBody(content: string, start: number): string {
  const open = content.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < content.length; i += 1) {
    const ch = content[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return content.slice(open, i + 1)
    }
  }
  return content.slice(open)
}

export function findAddonsWithoutSuper(
  files: readonly { readonly rel: string; readonly content: string }[],
): AddonSuperFinding[] {
  const findings: AddonSuperFinding[] = []
  for (const { rel, content } of files) {
    const lines = content.split('\n')
    let offset = 0
    for (const [i, text] of lines.entries()) {
      const match = CLASS_RE.exec(text)
      if (match !== null && match[4] === undefined) {
        const body = classBody(content, offset)
        const ctor = body.indexOf('constructor(')
        const callsSuper = ctor >= 0 && body.slice(ctor).includes('super(')
        if (!callsSuper) findings.push({ file: rel, line: i + 1, className: match[5] ?? '?' })
      }
      offset += text.length + 1
    }
  }
  return findings
}

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

function main(): void {
  const roots = [path.join(ROOT, 'server/backend/src')]
  for (const pkg of readdirSync(path.join(ROOT, 'packages')))
    roots.push(path.join(ROOT, 'packages', pkg, 'src'))
  const paths: string[] = []
  for (const root of roots) walk(root, paths)
  const files = paths.map((p) => ({
    rel: path.relative(ROOT, p).split(path.sep).join('/'),
    content: readFileSync(p, 'utf-8'),
  }))
  const findings = findAddonsWithoutSuper(files)
  if (findings.length === 0) {
    console.log(
      `check-addon-calls-super: ${files.length} runtime files, every addon class calls super()`,
    )
    return
  }
  console.error(
    'check-addon-calls-super: an addon class without `constructor() { super({}) }` hands BaseAddon an undefined config and fails to initialise on the node:',
  )
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.className}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
