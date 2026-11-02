#!/usr/bin/env tsx
/**
 * Scoped settings are declared by a capability the addon provides, in ONE scope (D986).
 *
 * An addon declares its settings through three hooks on `BaseAddon`, each answering for ONE
 * capability name (`cap`):
 *
 *   clusterSettingsSchema(cap)  deviceDefaultsSchema(cap)  nodeSettingsSchema(cap)
 *
 * The rows land in `addon-settings` as `<addonId>.<field>` (cluster and fleet default) or
 * `<addonId>.<field>@<nodeId>` (node). That shape is why three things must hold, and each is a
 * finding here:
 *
 * 1. **The cap is one the manifest provides.** A schema keyed to a cap name nobody provides is a
 *    form that never renders and a value nobody reads.
 * 2. **The scopes of one addon declare disjoint keys.** `cluster`, `device-defaults` and `node`
 *    share the id space `<addonId>.<field>`: one field name in two scopes is one row with two
 *    meanings, the second authority over one fact D224 forbids.
 * 3. **A schema key never contains `@`.** `@` is the node separator the id carries; a key with
 *    one would read as another node's row.
 *
 * Textual, like its neighbours: a hook body is found by its declaration and brace-matched, the cap
 * names are the string literals the body compares its parameter with (`cap === 'x'`,
 * `case 'x':`), and the keys are the `key: '...'` literals in the body plus those of the top-level
 * `const`s and functions of the SAME file it names (one hop). A hook whose body is only
 * `return null` declares nothing and is skipped; any other hook that names no cap is a finding.
 * A schema built from a helper imported from another file is invisible here, and the way to keep it
 * checked is to name the keys in the file that declares the hook.
 *
 * Usage: npx tsx scripts/check-scoped-settings-declared.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SCOPE_OF_HOOK: Readonly<Record<string, string>> = {
  clusterSettingsSchema: 'cluster',
  deviceDefaultsSchema: 'device-defaults',
  nodeSettingsSchema: 'node',
}

const HOOK_RE =
  /\b(clusterSettingsSchema|deviceDefaultsSchema|nodeSettingsSchema)\s*\(\s*(\w+)\s*(?::\s*[\w<>|'" ]+)?\)\s*(?::\s*[^{;=]+)?\{/g

export interface ScopedSource {
  readonly rel: string
  readonly content: string
}

export interface ScopedFinding {
  readonly file: string
  readonly message: string
}

/** Strip `//` and block comments, keeping line structure. Strings holding `//` lose their tail; keys stay found. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '')
}

/** The text of the `{ … }` block opening at `open` (inclusive), or the rest of the file. */
function block(content: string, open: number): string {
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

const TOP_LEVEL_DECL_RE =
  /^(?:export\s+)?(?:async\s+)?(?:const|function|class|interface|type)\s+(\w+)/gm

/** Every top-level declaration of the file, by name: the text from its line to the next declaration. */
function topLevelDeclarations(content: string): ReadonlyMap<string, string> {
  const starts: { name: string; index: number }[] = []
  for (const match of content.matchAll(TOP_LEVEL_DECL_RE)) {
    starts.push({ name: match[1] ?? '', index: match.index ?? 0 })
  }
  const out = new Map<string, string>()
  for (const [i, start] of starts.entries()) {
    out.set(start.name, content.slice(start.index, starts[i + 1]?.index ?? content.length))
  }
  return out
}

function literalsOf(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1] ?? '').filter((s) => s !== '')
}

interface HookDeclaration {
  readonly scope: string
  readonly caps: readonly string[]
  readonly keys: readonly string[]
  readonly declaresNothing: boolean
}

function declarationsIn(content: string): HookDeclaration[] {
  const clean = withoutComments(content)
  const decls = topLevelDeclarations(clean)
  const out: HookDeclaration[] = []
  for (const match of clean.matchAll(HOOK_RE)) {
    const hook = match[1] ?? ''
    const param = match[2] ?? 'cap'
    const open = (match.index ?? 0) + match[0].length - 1
    const body = block(clean, open)
    const inner = body.slice(1, -1).trim()
    if (/^return\s+null\s*;?$/.test(inner)) {
      out.push({ scope: SCOPE_OF_HOOK[hook] ?? hook, caps: [], keys: [], declaresNothing: true })
      continue
    }
    const caps = new Set<string>([
      ...literalsOf(body, new RegExp(`\\b${param}\\s*[!=]==?\\s*['"]([^'"]+)['"]`, 'g')),
      ...literalsOf(body, new RegExp(`['"]([^'"]+)['"]\\s*[!=]==?\\s*${param}\\b`, 'g')),
      ...literalsOf(body, /\bcase\s+['"]([^'"]+)['"]\s*:/g),
    ])
    let reachable = body
    for (const ident of new Set(body.match(/\b[A-Za-z_]\w*\b/g) ?? [])) {
      const text = decls.get(ident)
      if (text !== undefined) reachable += `\n${text}`
    }
    const keys = new Set(literalsOf(reachable, /\bkey\s*:\s*['"]([^'"]+)['"]/g))
    out.push({
      scope: SCOPE_OF_HOOK[hook] ?? hook,
      caps: [...caps],
      keys: [...keys],
      declaresNothing: false,
    })
  }
  return out
}

/** The package directory (`packages/<name>`) a source path belongs to, or `null`. */
function packageOf(rel: string): string | null {
  const parts = rel.split('/')
  return parts[0] === 'packages' && parts[1] !== undefined ? `packages/${parts[1]}` : null
}

/**
 * @param manifestCaps the capability names each package's manifest declares, by package directory
 *   (`packages/addon-x`): the union over the addon entries the package ships.
 */
export function findScopedSettingsFindings(
  files: readonly ScopedSource[],
  manifestCaps: ReadonlyMap<string, ReadonlySet<string>>,
): ScopedFinding[] {
  const findings: ScopedFinding[] = []
  for (const { rel, content } of files) {
    const declared = declarationsIn(content).filter((d) => !d.declaresNothing)
    if (declared.length === 0) continue
    const provided = manifestCaps.get(packageOf(rel) ?? '') ?? new Set<string>()
    const keyScopes = new Map<string, Set<string>>()
    for (const decl of declared) {
      if (decl.caps.length === 0) {
        findings.push({
          file: rel,
          message: `the ${decl.scope} settings schema names no capability: compare the hook's parameter with a literal (\`cap === 'x'\` or \`case 'x':\`)`,
        })
      }
      for (const cap of decl.caps) {
        if (!provided.has(cap)) {
          findings.push({
            file: rel,
            message: `the ${decl.scope} settings schema names capability "${cap}", which no manifest of ${packageOf(rel) ?? 'this package'} provides`,
          })
        }
      }
      for (const key of decl.keys) {
        if (key.includes('@')) {
          findings.push({
            file: rel,
            message: `the ${decl.scope} settings key "${key}" contains "@", the node separator of the row id`,
          })
        }
        const scopes = keyScopes.get(key) ?? new Set<string>()
        scopes.add(decl.scope)
        keyScopes.set(key, scopes)
      }
    }
    for (const [key, scopes] of keyScopes) {
      if (scopes.size > 1) {
        findings.push({
          file: rel,
          message: `the key "${key}" is declared in more than one scope (${[...scopes].join(', ')}): the scopes of one addon share the id <addonId>.<field> and must be disjoint`,
        })
      }
    }
  }
  return findings
}

// ── the repository walk ──────────────────────────────────────────────

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The capability names a package.json's `camstack.addons[].capabilities[].name` declare. */
export function capsOfManifest(raw: unknown): Set<string> {
  const caps = new Set<string>()
  const camstack = isRecord(raw) ? raw['camstack'] : undefined
  const addons = isRecord(camstack) ? camstack['addons'] : undefined
  if (!Array.isArray(addons)) return caps
  for (const addon of addons) {
    const list = isRecord(addon) ? addon['capabilities'] : undefined
    if (!Array.isArray(list)) continue
    for (const cap of list) {
      const name = typeof cap === 'string' ? cap : isRecord(cap) ? cap['name'] : undefined
      if (typeof name === 'string') caps.add(name)
    }
  }
  return caps
}

function main(): void {
  const manifestCaps = new Map<string, ReadonlySet<string>>()
  const sources: ScopedSource[] = []
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    const dir = path.join(ROOT, 'packages', pkg)
    try {
      manifestCaps.set(
        `packages/${pkg}`,
        capsOfManifest(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8'))),
      )
    } catch {
      continue
    }
    const paths: string[] = []
    walk(path.join(dir, 'src'), paths)
    for (const p of paths) {
      sources.push({
        rel: path.relative(ROOT, p).split(path.sep).join('/'),
        content: readFileSync(p, 'utf-8'),
      })
    }
  }
  const findings = findScopedSettingsFindings(sources, manifestCaps)
  if (findings.length === 0) {
    console.log(
      `check-scoped-settings-declared: ${sources.length} runtime files, every scoped schema is declared by a provided capability, keys disjoint and without "@"`,
    )
    return
  }
  console.error(
    'check-scoped-settings-declared: a scoped settings declaration is malformed (D986):',
  )
  for (const f of findings) console.error(`  ${f.file}: ${f.message}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
