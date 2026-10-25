/**
 * parse-storage — derive the SQLite storage map from the source.
 *
 * There is no schema file to read. Tables come into existence four ways, and a
 * map that shows only one of them is worse than none:
 *
 *  1. **Canonical KV collections** — a fixed list in `SqliteSettingsBackend`,
 *     each `(id TEXT PRIMARY KEY, data TEXT NOT NULL)`.
 *  2. **Per-addon scoped variants** — `<addonId>:<canonical>`, created ON DEMAND
 *     the first time an addon writes. They are never declared at boot, so they
 *     exist on a live hub and appear in no source file. Only the RULE is
 *     derivable, never the list.
 *  3. **Declared collections** — an addon calls `declareCollection()` with its
 *     own columns. These are the typed, domain-owned tables.
 *  4. **Raw DDL** — an addon runs `CREATE TABLE` itself.
 *
 * There used to be a fifth: `ensureTable()`, a second table-shaped API on the
 * same backend that created typed tables without `declareCollection`. Seven
 * live tables (`devices`, `integrations`, `integration_settings`,
 * `device_settings_kv`, `storage_locations`, `backup_schedules`,
 * `backup_destination_policies`) were invisible to this map until it was
 * matched separately. B2 moved all seven onto `declareCollection` and deleted
 * that API, so they are now found by the scan in (3) like everything else.
 *
 * Anything a static read cannot resolve is REPORTED, not dropped: a map that
 * silently omits what it failed to parse reads as "that is all there is", which
 * is the failure this file exists to prevent.
 *
 * ## The `@durable` annotation
 *
 * A table's NAME says nothing about whether losing it is a bug. The 2026-08-13
 * census had to derive that by reading five files, and it found two collections
 * whose class nobody had ever decided (`NodeStressController`'s move history,
 * the device-features mirror) — both cold-start bugs, both shipped.
 *
 * So a declared collection may carry, in the docblock of the constant that
 * names it:
 *
 * ```
 * /**
 *  * (at)durable class=ledger owner=notification-center
 *  *   write="a liveness transition the centre accepted"
 *  *   retention="none — one row per subject"
 *  *\/
 * export const NC_LIVENESS_COLLECTION = 'notification-center:liveness'
 * ```
 *
 * Four fields, all required: `class` (see {@link DURABLE_CLASSES}), `owner`,
 * `write` (what causes a row to be written) and `retention` (what causes one to
 * go, or why nothing does). It is a COMMENT rather than a typed field on
 * purpose: it has to work for the collections that will never use a shared
 * primitive — raw DDL, the kernel's canonical KV list, another package's store
 * — and a second typed authority is the shape this repo has shipped wrong
 * twice.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** The vocabulary a `@durable class=` may use. See the census's §1 table. */
export const DURABLE_CLASSES = ['ledger', 'mirror', 'ephemeral', 'config', 'audit'] as const
export type DurableClass = (typeof DURABLE_CLASSES)[number]

/** A parsed `@durable` annotation. */
export interface DurableAnnotation {
  /** The collection literal the annotated constant resolves to. */
  readonly collection: string
  readonly semanticClass: string
  readonly owner: string
  readonly writeTrigger: string
  readonly retention: string
  /** Absent = settings (D851). */
  readonly database: string
  readonly file: string
}

/** A table an addon declares for itself, with the columns it asked for. */
export interface DeclaredCollection {
  /** Collection name, or the unresolved expression when it is not a literal. */
  readonly name: string
  /** True when `name` came from a string literal or a same-file constant. */
  readonly resolved: boolean
  /** Repo-relative file the call sits in. */
  readonly file: string
  /** Column names, when the spec is a resolvable same-file array literal. */
  readonly columns: readonly string[]
  /** Present when the call names `database:` explicitly; absent = settings. */
  readonly database?: string
}

export interface StorageMap {
  /** The fixed KV list every scope is built from. */
  readonly canonical: readonly string[]
  /** Typed tables, sorted by name. */
  readonly declared: readonly DeclaredCollection[]
  /** Call sites whose collection name is not statically knowable. */
  readonly unresolved: readonly DeclaredCollection[]
}

const SKIP = /(\/dist\/|\/node_modules\/|__tests__|\.d\.ts$)/

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      walk(full, out)
    } else if (entry.name.endsWith('.ts') && !SKIP.test(full)) {
      out.push(full)
    }
  }
}

/** Source files worth scanning, under the given roots. */
export function collectSourceFiles(root: string, roots: readonly string[]): string[] {
  const files: string[] = []
  for (const r of roots) walk(path.join(root, r), files)
  return files.sort()
}

/** The canonical KV list, read from the backend that owns it. */
export function parseCanonical(backendSource: string): string[] {
  const block = /CANONICAL_KV_COLLECTIONS[^=]*=\s*\[([\s\S]*?)\]/.exec(backendSource)
  if (block === null) return []
  return [...block[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1])
}

/** Resolve `const NAME = 'value'` within one file. */
function literalConstants(source: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const m of source.matchAll(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*['"`]([^'"`]+)['"`]/g,
  )) {
    map.set(m[1], m[2])
  }
  return map
}

/** Column names from a same-file `const NAME = [ { name: 'x', … }, … ]`. */
function columnsOf(source: string, identifier: string): string[] {
  const re = new RegExp(`(?:const|let)\\s+${identifier}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\n\\s*\\]`)
  const block = re.exec(source)
  if (block === null) return []
  return [...block[1].matchAll(/name:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1])
}

/**
 * Every `declareCollection(...)` call in one file.
 *
 * Two shapes are in use — the backend's object form
 * (`{ collection, columns }`) and the port interfaces' two-argument form
 * (`(collection, columns)`) — so both are matched. So is the tRPC client form,
 * `declareCollection.mutate({ … })`: missing it hid the LARGEST tables in the
 * system (tracks, media, events) from the first version of this map. Interface DECLARATIONS
 * (`declareCollection(input: {`, `declareCollection(collection: string`) are
 * signatures, not call sites, and are excluded.
 */
export function parseDeclarations(source: string, relFile: string): DeclaredCollection[] {
  const consts = literalConstants(source)
  const out: DeclaredCollection[] = []

  for (const m of source.matchAll(/declareCollection(?:\.mutate)?\(\s*([\s\S]{0,400}?)\)/g)) {
    const args = m[1]
    // A type annotation means this is the signature, not a call.
    if (/^\s*\w+\s*:/.test(args) && !/^\s*\{/.test(args)) continue

    // The FIRST argument (or `collection:`) however it is written. A loose
    // match on purpose: an expression this cannot resolve — `this.collection`,
    // a template literal, a parameter — must surface as unresolved rather than
    // fail the regex and vanish. A dropped call site reads as "no such table".
    const objName = /collection:\s*(?:['"`]([^'"`]+)['"`]|([^,}\n]+))/.exec(args)
    const posName = /^\s*(?:['"`]([^'"`]+)['"`]|([^,\n]+?))\s*,/.exec(args)
    const hit = objName ?? posName
    if (hit === null) continue

    const literal = hit[1]
    const expr = hit[2]?.trim()
    const fromConst = expr !== undefined ? consts.get(expr) : undefined
    const name = literal ?? fromConst ?? expr ?? ''
    if (name === '' || name === 'input') continue
    const resolved = literal !== undefined || fromConst !== undefined

    // `columns: COLS`, `columns: [...COLS]` and the two-arg `(name, COLS)` all
    // occur. Without the spread form the columns silently came back empty and
    // an INDEX array got picked up in their place — wrong data reads as fact.
    const colIdent =
      /columns:\s*\[?\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)/.exec(args) ??
      /,\s*([A-Z][\w$]*)\s*$/.exec(args)
    const inlineCols = [...args.matchAll(/name:\s*['"`]([^'"`]+)['"`]/g)].map((c) => c[1])
    // Columns are BEST-EFFORT and the renderer does not publish them: the
    // 400-char call window truncates large schemas, and an `indexes:` array
    // then gets picked up in their place. A partly-wrong column list reads as
    // authoritative, so the map points at the owning file instead — that
    // pointer cannot rot. Kept here for callers that want a hint.
    const raw = inlineCols.length > 0 ? inlineCols : colIdent ? columnsOf(source, colIdent[1]) : []
    const columns = raw.filter((c) => !c.startsWith('idx_'))

    const dbMatch = /database:\s*['"`](settings|events|history)['"`]/.exec(args)
    const database = dbMatch?.[1]
    out.push({
      name,
      resolved,
      file: relFile,
      columns,
      ...(database !== undefined ? { database } : {}),
    })
  }
  return out
}

/**
 * Tables created by raw DDL rather than through `declareCollection`.
 *
 * Some addons own their schema outright and run `CREATE TABLE` themselves
 * (`pipeline-analytics`, `local-auth`). Those tables are as real as any other;
 * omitting them because they took a different route is how a map becomes a
 * half-truth. Interpolated names (`"${scoped}"`) are reported as unresolved —
 * they are the per-addon scoped variants, whose list only exists at runtime.
 */
export function parseRawTables(source: string, relFile: string): DeclaredCollection[] {
  // Comments FIRST. Prose describing the schema (`… runs CREATE TABLE IF NOT
  // EXISTS …` in a docblock, wrapped across ` * ` continuations) otherwise
  // parses as a table literally named "IF".
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const out: DeclaredCollection[] = []
  for (const m of code.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([^\s"'`(]+)["'`]?/gi,
  )) {
    const name = m[1]
    if (/^(if|not|exists)$/i.test(name)) continue
    out.push({
      name,
      resolved: !name.includes('${'),
      file: relFile,
      columns: [],
    })
  }
  return out
}

/**
 * Every `@durable` annotation in one file.
 *
 * An annotation binds to the FIRST string-literal constant declared after it —
 * which is the collection-name constant, because that is where the annotation
 * is required to sit. An annotation followed by no such constant is DROPPED
 * rather than guessed at: a catalogue row attached to the wrong table is worse
 * than a missing one.
 *
 * `export` is OPTIONAL. Roughly half the collection-name constants in this repo
 * are module-private (`const COLLECTION = 'share_view_tokens'`) because nothing
 * outside the owning file needs the name. Requiring `export` here would have
 * meant widening fifteen modules' public surface to satisfy a regex — a change
 * that reads, to the next person, as though something imports them. Whether a
 * name is exported says nothing about whether losing its table is a bug, which
 * is the only question this annotation exists to answer.
 */
export function parseDurableAnnotations(source: string, relFile: string): DurableAnnotation[] {
  const out: DurableAnnotation[] = []
  for (const m of source.matchAll(/@durable\b([\s\S]*?)\*\//g)) {
    const body = m[1].replace(/^[ \t]*\*[ \t]?/gm, ' ')
    const after = source.slice(m.index + m[0].length)
    const decl =
      /^\s*(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*['"`]([^'"`]+)['"`]/.exec(after)
    if (decl === null) continue
    const field = (name: string): string => {
      const quoted = new RegExp(`${name}="([^"]*)"`).exec(body)
      if (quoted !== null) return quoted[1].replace(/\s+/g, ' ').trim()
      const bare = new RegExp(`${name}=([^\\s"]+)`).exec(body)
      return bare === null ? '' : bare[1].trim()
    }
    const database = field('database')
    out.push({
      collection: decl[1],
      semanticClass: field('class'),
      owner: field('owner'),
      writeTrigger: field('write'),
      retention: field('retention'),
      database: database === '' ? 'settings' : database,
      file: relFile,
    })
  }
  return out
}

/** Every `@durable` annotation in the workspace, by collection name. */
export function buildDurableCatalogue(
  root: string,
  roots: readonly string[] = ['packages', 'server'],
): ReadonlyMap<string, DurableAnnotation> {
  const out = new Map<string, DurableAnnotation>()
  for (const file of collectSourceFiles(root, roots)) {
    const source = fs.readFileSync(file, 'utf-8')
    if (!source.includes('@durable')) continue
    for (const annotation of parseDurableAnnotations(source, path.relative(root, file))) {
      out.set(annotation.collection, annotation)
    }
  }
  return out
}

/** Build the whole map from the workspace. */
export function buildStorageMap(root: string, backendFile: string): StorageMap {
  const canonical = parseCanonical(fs.readFileSync(backendFile, 'utf-8'))

  const seen = new Map<string, DeclaredCollection>()
  const unresolved: DeclaredCollection[] = []

  for (const file of collectSourceFiles(root, ['packages', 'server'])) {
    const source = fs.readFileSync(file, 'utf-8')
    const rel = path.relative(root, file)
    const hasDecl = source.includes('declareCollection')
    const hasDdl = /CREATE\s+TABLE/i.test(source)
    if (!hasDecl && !hasDdl) continue
    const found = [
      ...(hasDecl ? parseDeclarations(source, rel) : []),
      ...(hasDdl ? parseRawTables(source, rel) : []),
    ]
    for (const decl of found) {
      if (!decl.resolved) {
        unresolved.push(decl)
        continue
      }
      // Same collection declared from several call sites: keep the richest.
      const held = seen.get(decl.name)
      if (held === undefined || decl.columns.length > held.columns.length) {
        seen.set(decl.name, decl)
      }
    }
  }

  const declared = [...seen.values()]
    .filter((d) => !canonical.includes(d.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { canonical, declared, unresolved }
}
