#!/usr/bin/env tsx
/**
 * Collection-cap pin guard — a call that NAMES a resource must say whose.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * A `mode:'collection'` capability has several providers, each owning a
 * DISJOINT set of resources: `provider-homematic` owns every `hm_*` broker,
 * `provider-homeassistant` owns every `ha_*` one. The router resolves an
 * unpinned call to the FIRST-REGISTERED provider, so a call that names a
 * resource belonging to somebody else is answered — politely, with `null` —
 * by an addon that has never heard of it. Measured on the live hub,
 * 2026-08-09:
 *
 *   broker.getBrokerConfig { id: 'ha_001' }                        → null
 *   broker.getBrokerConfig { id: 'ha_001', addonId: 'provider-homeassistant' }
 *                                                                  → the config
 *   broker.getState { brokerId: 'ha_001', key: 'sun.sun' }          → null
 *   broker.getState { …, addonId: 'provider-homeassistant' }        → the entity
 *
 * `null` is the worst possible answer here: it is also what a legitimately
 * unknown id returns, so the caller has no way to tell "not mine" from "not
 * there" and degrades silently. Those two readings were taken from the tRPC
 * router — i.e. from OUTSIDE the providing process, which is the only place
 * the pin matters. See the exemption below for why the same call inside
 * `provider-homeassistant` neither needs a pin nor may have one.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * For a `mode:'collection'` capability `<cap>`, a `ctx.api.<cap>.<method>`
 * call whose input literal contains a RESOURCE KEY — `id`, or `<cap>Id`
 * (`brokerId`, `llmId`) — must also carry `addonId`.
 *
 * ── The exemption, which is not an exception ───────────────────────────────
 * A package that DECLARES the capability in its own manifest is exempt. This
 * is not politeness; pinning there is a live hazard, and it cost an outage on
 * 2026-08-09.
 *
 * An addon's capabilities are registered by what its `initialize()` RETURNS,
 * so they are absent for the whole of its own boot. `provider-homeassistant`
 * restores 239 Home Assistant devices inside that window, and each device
 * activation calls `broker.subscribe` / `broker.getState`. Pinned, those calls
 * name a provider that cannot exist yet — the cap cannot register until
 * restore finishes, and restore cannot finish until the pin resolves. The
 * addon never completed `initialize()` again, and the four capabilities it
 * returns (`broker`, `device-adoption`, `notification-output`, `addon-routes`)
 * stayed unregistered across two restarts.
 *
 * In-process the pin buys nothing anyway: `localProviderLink` short-circuits
 * any cap the calling process already provides, so the call never reaches the
 * collection resolver that a pin would steer.
 *
 * ── What it does NOT catch, stated rather than implied ─────────────────────
 * A call that names no resource. `broker.list({})` is unpinned-legal by this
 * rule, and that is deliberate: an enumeration's contract IS the union across
 * providers, so a pin converts a provider's absence from "returns fewer rows"
 * into "throws BAD_REQUEST". Pinning that one call is what turned the
 * operator's hub from "one instance, switched off" into "no instance at all".
 * Nor does this catch a spread (`{ ...args }`) or a variable argument; both are
 * skipped rather than guessed at.
 *
 * Usage: npx tsx scripts/check-collection-cap-pin.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const CAP_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const SCAN_ROOTS = ['packages', 'server/backend/src']

/** Resource-id key names that are NOT a collection resource selector. */
const NOT_A_RESOURCE_KEY = new Set(['deviceId', 'nodeId', 'addonId'])

/**
 * Capabilities declared by the ADDON that owns `file` — per manifest ENTRY,
 * not per package. One package can ship several addons
 * (`packages/addon-provider-homeassistant` ships the `provider-homeassistant`
 * import half, which provides `broker`, and the `homeassistant-export` half,
 * which does NOT and must pin). Exempting the whole package would have let the
 * export half's `getBrokerConfig` go unpinned — the exact call whose missing
 * pin returns `null` from Homematic.
 *
 * A file is attributed to the entry whose source directory is its LONGEST
 * matching ancestor: `./dist/ha-export/ha-export.addon.js` claims
 * `src/ha-export/**`, `./dist/addon.js` claims the rest of `src/**`.
 */
const declaredCache = new Map<string, readonly AddonEntry[]>()

interface AddonEntry {
  /** Absolute source directory this entry owns. */
  readonly dir: string
  readonly caps: ReadonlySet<string>
}

function owningPackageRoot(file: string): string | null {
  let dir = path.dirname(file)
  while (dir.startsWith(ROOT) && dir !== ROOT) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  return null
}

/** `./dist/ha-export/ha-export.addon.js` → `<root>/src/ha-export`. */
function entrySourceDir(root: string, entry: unknown): string {
  if (typeof entry !== 'string') return path.join(root, 'src')
  const rel = entry.replace(/^\.\//, '').replace(/^dist\//, '')
  const dir = path.dirname(rel)
  return path.join(root, 'src', dir === '.' ? '' : dir)
}

function addonEntries(root: string): readonly AddonEntry[] {
  const cached = declaredCache.get(root)
  if (cached !== undefined) return cached
  const entries: AddonEntry[] = []
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const camstack =
      typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'camstack') : undefined
    const addons =
      typeof camstack === 'object' && camstack !== null
        ? Reflect.get(camstack, 'addons')
        : undefined
    if (Array.isArray(addons)) {
      for (const addon of addons) {
        if (typeof addon !== 'object' || addon === null) continue
        const caps = new Set<string>()
        for (const key of ['caps', 'capabilities']) {
          const list = Reflect.get(addon, key)
          if (!Array.isArray(list)) continue
          for (const cap of list) {
            if (typeof cap === 'string') caps.add(cap)
            else if (typeof cap === 'object' && cap !== null) {
              const name = Reflect.get(cap, 'name')
              if (typeof name === 'string') caps.add(name)
            }
          }
        }
        entries.push({ dir: entrySourceDir(root, Reflect.get(addon, 'entry')), caps })
      }
    }
  } catch {
    // An unreadable/!JSON manifest exempts nothing — fall through to empty.
  }
  declaredCache.set(root, entries)
  return entries
}

/** Capabilities provided by the addon that owns `file` (longest-prefix match). */
function declaredCapabilities(file: string): ReadonlySet<string> {
  const root = owningPackageRoot(file)
  if (root === null) return new Set()
  let best: AddonEntry | null = null
  for (const entry of addonEntries(root)) {
    if (!file.startsWith(`${entry.dir}${path.sep}`)) continue
    if (best === null || entry.dir.length > best.dir.length) best = entry
  }
  return best?.caps ?? new Set()
}

interface Violation {
  readonly file: string
  readonly line: number
  readonly cap: string
  readonly method: string
  readonly keys: readonly string[]
}

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
}

/** Collection cap names, parsed from the authoritative `*.cap.ts` files. */
function collectionCapNames(): ReadonlySet<string> {
  const out = new Set<string>()
  for (const file of fs.readdirSync(CAP_DIR)) {
    if (!file.endsWith('.cap.ts')) continue
    const text = fs.readFileSync(path.join(CAP_DIR, file), 'utf8')
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const prop = (key: string): ts.PropertyAssignment | undefined =>
          node.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText() === key,
          )
        const nameProp = prop('name')
        const modeProp = prop('mode')
        if (
          nameProp !== undefined &&
          modeProp !== undefined &&
          prop('methods') !== undefined &&
          ts.isStringLiteral(nameProp.initializer) &&
          ts.isStringLiteral(modeProp.initializer) &&
          modeProp.initializer.text === 'collection'
        ) {
          out.add(nameProp.initializer.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(src)
  }
  return out
}

function sourceFiles(dir: string, acc: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry.name)) acc.push(full)
  }
  return acc
}

function scanFile(file: string, byCamel: ReadonlyMap<string, string>): Violation[] {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes('.api.')) return []
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: Violation[] = []

  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit)
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return
    const callKind = node.expression.name.getText()
    if (callKind !== 'query' && callKind !== 'mutate') return
    const procedure = node.expression.expression
    if (!ts.isPropertyAccessExpression(procedure)) return
    const capAccess = procedure.expression
    if (!ts.isPropertyAccessExpression(capAccess)) return
    // Only `<something>.api.<cap>.<method>.query|mutate(...)`.
    if (!/(^|\.)api$/.test(capAccess.expression.getText())) return

    const capCamel = capAccess.name.getText()
    const capName = byCamel.get(capCamel)
    if (capName === undefined) return
    // A package calling a cap it PROVIDES is exempt — pinning there deadlocks
    // its own boot and buys nothing (localProviderLink short-circuits it).
    if (declaredCapabilities(file).has(capName)) return

    const arg = node.arguments[0]
    if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return
    if (arg.properties.some((p) => ts.isSpreadAssignment(p))) return

    const keys = arg.properties.map((p) => p.name?.getText() ?? '')
    const resourceKeys = new Set(['id', `${capCamel}Id`])
    const namesResource = keys.some((k) => resourceKeys.has(k) && !NOT_A_RESOURCE_KEY.has(k))
    if (!namesResource || keys.includes('addonId')) return

    found.push({
      file: path.relative(ROOT, file),
      line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
      cap: capName,
      method: procedure.name.getText(),
      keys,
    })
  }

  visit(src)
  return found
}

function main(): void {
  const collections = collectionCapNames()
  const byCamel = new Map([...collections].map((name) => [kebabToCamel(name), name]))

  const files = SCAN_ROOTS.flatMap((rel) => {
    const abs = path.join(ROOT, rel)
    return fs.existsSync(abs) ? sourceFiles(abs, []) : []
  })

  const violations = files.flatMap((file) => scanFile(file, byCamel))

  if (violations.length > 0) {
    console.error('✖ collection-cap pin guard: unpinned call naming a collection resource\n')
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`)
      console.error(`    ${v.cap}.${v.method}({ ${v.keys.join(', ')} }) — no addonId`)
    }
    console.error(
      `\n"${[...collections].join('", "')}" are mode:'collection' capabilities: several addons`,
    )
    console.error('register a provider and each owns a DISJOINT set of resources. An unpinned')
    console.error('call is answered by the FIRST-REGISTERED provider, which returns null for a')
    console.error('resource it does not own — indistinguishable from "no such resource".')
    console.error("Add the owning addon's id: `{ …, addonId: '<owner>' }`.")
    process.exit(1)
  }

  console.log(
    `✔ collection-cap pin guard: ${files.length} files, ${collections.size} collection caps, 0 unpinned resource calls`,
  )
}

main()
