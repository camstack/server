/**
 * Addon-local codegen: scan vendored HACS `source/*.py` + README and emit
 * `src/catalog.json` (modules + country → service tree with inferred fields).
 *
 * Run: `npx tsx packages/addon-waste-collections/scripts/gen-catalog.ts`
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const SOURCE_DIR = join(PKG_ROOT, 'python/vendor/waste_collection_schedule/source')
const SERVICE_DIR = join(PKG_ROOT, 'python/vendor/waste_collection_schedule/service')
const README_PATH = join(PKG_ROOT, 'python/vendor/README-sources.md')
const OUT_PATH = join(PKG_ROOT, 'src/catalog.json')

export interface CatalogEntry {
  readonly module: string
  readonly title: string
  readonly description: string
  readonly url: string | null
  readonly countries: readonly string[]
  readonly argHints: Readonly<Record<string, string>>
}

export interface CatalogField {
  readonly key: string
  readonly label: string
  readonly required: boolean
  readonly kind: 'text' | 'number' | 'boolean'
}

export interface CatalogService {
  readonly id: string
  readonly countryId: string
  readonly label: string
  readonly module: string
  readonly defaultArgs: Readonly<Record<string, string>>
  readonly fields: readonly CatalogField[]
}

export interface CatalogCountry {
  readonly id: string
  readonly label: string
}

export interface WasteCatalog {
  readonly generatedAt: string
  readonly sourceHash: string
  readonly entries: readonly CatalogEntry[]
  readonly countries: readonly CatalogCountry[]
  readonly services: readonly CatalogService[]
}

interface InitParam {
  readonly name: string
  readonly required: boolean
  readonly kind: 'text' | 'number' | 'boolean'
}

interface ExtraInfoRow {
  readonly title: string
  readonly defaultParams: Record<string, string>
  readonly country?: string
}

interface ReadmeBullet {
  readonly countryLabel: string
  readonly label: string
  readonly module: string
}

function slugify(raw: string): string {
  const s = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.length > 0 ? s.slice(0, 80) : 'x'
}

function countryIdOf(label: string): string {
  if (label === 'generic' || label === 'ICS/iCal and User-Specified') return 'generic'
  return slugify(label)
}

function extractStringAssign(src: string, name: string): string | null {
  const re = new RegExp(`^${name}\\s*=\\s*(.+)$`, 'm')
  const m = src.match(re)
  if (!m?.[1]) return null
  const raw = m[1].trim()
  if (raw === 'None') return null
  const dq = raw.match(/^"((?:\\.|[^"\\])*)"/)
  if (dq?.[1] !== undefined) return dq[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
  const sq = raw.match(/^'((?:\\.|[^'\\])*)'/)
  if (sq?.[1] !== undefined) return sq[1].replace(/\\n/g, '\n').replace(/\\'/g, "'")
  return null
}

/** Best-effort PARAM_TRANSLATIONS['en'] map — empty when absent or unparseable. */
export function extractArgHints(src: string): Record<string, string> {
  const block = src.match(/PARAM_TRANSLATIONS\s*=\s*\{([\s\S]*?)\n\}/)
  if (!block?.[1]) return {}
  const en = block[1].match(/"en"\s*:\s*\{([\s\S]*?)\}/)
  if (!en?.[1]) return {}
  const out: Record<string, string> = {}
  const pairRe = /"([^"]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g
  for (const m of en[1].matchAll(pairRe)) {
    out[m[1]!] = m[2]!.replace(/\\"/g, '"')
  }
  return out
}

/**
 * Parse `Source.__init__(self, …)` parameters. Best-effort — skips *args/**kwargs.
 */
export function extractInitParams(src: string): readonly InitParam[] {
  const m = src.match(/class\s+Source\b[\s\S]*?def\s+__init__\s*\(([\s\S]*?)\)\s*(?:->|:) /)
  if (!m?.[1]) {
    const m2 = src.match(/def\s+__init__\s*\(([\s\S]*?)\)\s*(?:->[^:]+)?\s*:/)
    if (!m2?.[1]) return []
    return parseInitParamList(m2[1])
  }
  return parseInitParamList(m[1])
}

function parseInitParamList(raw: string): readonly InitParam[] {
  const flat = raw.replace(/#[^\n]*/g, ' ').replace(/\s+/g, ' ')
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of flat) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())

  const out: InitParam[] = []
  for (const part of parts) {
    if (!part || part === 'self' || part.startsWith('*')) continue
    const nameMatch = part.match(/^([A-Za-z_][A-Za-z0-9_]*)/)
    if (!nameMatch?.[1]) continue
    const name = nameMatch[1]
    const hasDefault = /=(?!=)/.test(part)
    let kind: InitParam['kind'] = 'text'
    if (/\bbool\b/.test(part)) kind = 'boolean'
    else if (/\bint\b|\bfloat\b/.test(part)) kind = 'number'
    out.push({ name, required: !hasDefault, kind })
  }
  return out
}

function extractParamDescriptions(src: string): Record<string, string> {
  const block = src.match(/PARAM_DESCRIPTIONS\s*=\s*\{([\s\S]*?)\n\}/)
  if (!block?.[1]) return {}
  const en = block[1].match(/"en"\s*:\s*\{([\s\S]*?)\}/)
  if (!en?.[1]) return {}
  const out: Record<string, string> = {}
  const pairRe = /"([^"]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g
  for (const m of en[1].matchAll(pairRe)) {
    out[m[1]!] = m[2]!.replace(/\\"/g, '"')
  }
  return out
}

/** Parse SERVICE_DOMAINS-style list of dicts with title + service_id. */
export function extractServiceDomainRows(src: string): readonly ExtraInfoRow[] {
  const block = src.match(/SERVICE_DOMAINS\s*=\s*\[([\s\S]*?)\]/)
  if (!block?.[1]) return []
  const rows: ExtraInfoRow[] = []
  for (const m of block[1].matchAll(/\{([^{}]+)\}/g)) {
    const body = m[1]!
    const title =
      body.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1] ??
      body.match(/'title'\s*:\s*'((?:\\.|[^'\\])*)'/)?.[1]
    const serviceId =
      body.match(/"service_id"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1] ??
      body.match(/'service_id'\s*:\s*'((?:\\.|[^'\\])*)'/)?.[1]
    if (!title || !serviceId) continue
    rows.push({ title: title.replace(/\\"/g, '"'), defaultParams: { service: serviceId } })
  }
  return rows
}

/**
 * EXTRA_INFO expansions: SERVICE_DOMAINS import, inline dict yields, or
 * SERVICE_PROVIDERS set iteration (title only → municipality default later).
 */
export function extractExtraInfoRows(
  moduleSrc: string,
  moduleName: string,
): readonly ExtraInfoRow[] {
  if (!/def\s+EXTRA_INFO\s*\(/.test(moduleSrc)) return []

  // Pattern: for s in SERVICE_DOMAINS → load companion service file
  const importMatch = moduleSrc.match(
    /from\s+waste_collection_schedule\.service\.([A-Za-z0-9_]+)\s+import\s+[^\n]*SERVICE_DOMAINS/,
  )
  if (importMatch?.[1] && /SERVICE_DOMAINS/.test(moduleSrc) && /EXTRA_INFO/.test(moduleSrc)) {
    const svcPath = join(SERVICE_DIR, `${importMatch[1]}.py`)
    if (existsSync(svcPath)) {
      const rows = extractServiceDomainRows(readFileSync(svcPath, 'utf8'))
      if (rows.length > 0) return rows
    }
  }

  // Inline SERVICE_DOMAINS in the same file
  if (/SERVICE_DOMAINS\s*=/.test(moduleSrc)) {
    const rows = extractServiceDomainRows(moduleSrc)
    if (rows.length > 0) return rows
  }

  // yield {"title": s, ...} over SERVICE_PROVIDERS / similar sets
  const setName = moduleSrc.match(
    /def\s+EXTRA_INFO[\s\S]*?for\s+\w+\s+in\s+([A-Z][A-Z0-9_]*)\s*:/,
  )?.[1]
  if (setName) {
    const setBlock = moduleSrc.match(new RegExp(`${setName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`))
    if (setBlock?.[1]) {
      const titles = [...setBlock[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) =>
        m[1]!.replace(/\\"/g, '"'),
      )
      if (titles.length > 0) {
        return titles.map((title) => ({ title, defaultParams: {} }))
      }
    }
  }

  // Static list return [ { "title": …, "default_params": {…} }, … ]
  const returnList = moduleSrc.match(/def\s+EXTRA_INFO[\s\S]*?return\s*\[([\s\S]*?)\]/)
  if (returnList?.[1]) {
    const rows: ExtraInfoRow[] = []
    for (const m of returnList[1].matchAll(/\{([^{}]+(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
      const body = m[1]!
      const title = body.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1]
      if (!title) continue
      const defaultParams: Record<string, string> = {}
      const dp = body.match(/"default_params"\s*:\s*\{([^}]*)\}/)
      if (dp?.[1]) {
        for (const p of dp[1].matchAll(/"([^"]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
          defaultParams[p[1]!] = p[2]!.replace(/\\"/g, '"')
        }
      }
      rows.push({ title: title.replace(/\\"/g, '"'), defaultParams })
    }
    if (rows.length > 0) return rows
  }

  void moduleName
  return []
}

function listSourceModules(): readonly string[] {
  return readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith('.py') && !f.startsWith('_'))
    .map((f) => f.replace(/\.py$/, ''))
    .sort()
}

function parseReadmeBullets(readme: string): readonly ReadmeBullet[] {
  const out: ReadmeBullet[] = []
  const sectionRe =
    /<summary>\s*([^<]+?)\s*<\/summary>([\s\S]*?)(?=<summary>|<\/details>\s*<!--End of country section-->|$)/gi
  for (const m of readme.matchAll(sectionRe)) {
    const raw = m[1]!.trim()
    const body = m[2] ?? ''
    const countryLabel = raw === 'ICS/iCal and User-Specified' ? 'generic' : raw
    for (const link of body.matchAll(/\[([^\]]+)\]\(\/doc\/(?:source|ics)\/([^)/]+)\.md\)/g)) {
      out.push({ countryLabel, label: link[1]!.trim(), module: link[2]! })
    }
  }
  return out
}

function parseCountriesByModule(bullets: readonly ReadmeBullet[]): Map<string, string[]> {
  const map = new Map<string, Set<string>>()
  for (const b of bullets) {
    let set = map.get(b.module)
    if (!set) {
      set = new Set()
      map.set(b.module, set)
    }
    set.add(b.countryLabel)
  }
  const out = new Map<string, string[]>()
  for (const [mod, set] of map) out.set(mod, [...set].sort())
  return out
}

const PLACEHOLDER_ARG_KEYS = new Set([
  'municipality',
  'comune',
  'ort',
  'city',
  'town',
  'gemeinde',
  'area',
])

function fieldsForModule(
  init: readonly InitParam[],
  hints: Record<string, string>,
  descriptions: Record<string, string>,
  defaultArgs: Readonly<Record<string, string>>,
): CatalogField[] {
  const fields: CatalogField[] = []
  for (const p of init) {
    if (defaultArgs[p.name] !== undefined) continue
    fields.push({
      key: p.name,
      label: hints[p.name] ?? p.name,
      required: p.required,
      kind: p.kind,
    })
    void descriptions
  }
  return fields
}

function serviceIdOf(
  module: string,
  label: string,
  defaultArgs: Readonly<Record<string, string>>,
): string {
  const fromArgs = defaultArgs['service'] ?? defaultArgs['service_id']
  if (typeof fromArgs === 'string' && fromArgs.length > 0) {
    return `${module}--${slugify(fromArgs)}`
  }
  return `${module}--${slugify(label)}`
}

function guessTitleDefault(
  init: readonly InitParam[],
  title: string,
  existing: Record<string, string>,
): Record<string, string> {
  if (Object.keys(existing).length > 0) return existing
  const candidate = init.find((p) => p.required && PLACEHOLDER_ARG_KEYS.has(p.name))
  if (!candidate) return existing
  return { ...existing, [candidate.name]: title }
}

export function buildCatalog(): WasteCatalog {
  const modules = listSourceModules()
  const readme = readFileSync(README_PATH, 'utf8')
  const bullets = parseReadmeBullets(readme)
  const byCountry = parseCountriesByModule(bullets)
  const hash = createHash('sha256')
  const entries: CatalogEntry[] = []
  const moduleMeta = new Map<
    string,
    {
      title: string
      init: readonly InitParam[]
      hints: Record<string, string>
      descriptions: Record<string, string>
      extra: readonly ExtraInfoRow[]
      src: string
    }
  >()

  for (const module of modules) {
    const path = join(SOURCE_DIR, `${module}.py`)
    const src = readFileSync(path, 'utf8')
    hash.update(module)
    hash.update('\0')
    hash.update(src)
    hash.update('\0')
    const hints = extractArgHints(src)
    const init = extractInitParams(src)
    const descriptions = extractParamDescriptions(src)
    const extra = extractExtraInfoRows(src, module)
    const title = extractStringAssign(src, 'TITLE') ?? module
    moduleMeta.set(module, { title, init, hints, descriptions, extra, src })
    entries.push({
      module,
      title,
      description: extractStringAssign(src, 'DESCRIPTION') ?? '',
      url: extractStringAssign(src, 'URL'),
      countries: byCountry.get(module) ?? [],
      argHints: hints,
    })
  }

  const countryLabels = new Map<string, string>()
  for (const b of bullets) {
    const id = countryIdOf(b.countryLabel)
    if (!countryLabels.has(id)) {
      countryLabels.set(id, b.countryLabel === 'generic' ? 'ICS / generic' : b.countryLabel)
    }
  }

  const services: CatalogService[] = []
  const seen = new Set<string>()

  const pushService = (
    countryId: string,
    label: string,
    module: string,
    defaultArgsIn: Record<string, string>,
  ): void => {
    const meta = moduleMeta.get(module)
    if (!meta) return
    const defaultArgs = guessTitleDefault(meta.init, label, defaultArgsIn)
    const id = serviceIdOf(module, label, defaultArgs)
    const dedupe = `${countryId}::${id}`
    if (seen.has(dedupe)) return
    seen.add(dedupe)
    services.push({
      id,
      countryId,
      label,
      module,
      defaultArgs,
      fields: fieldsForModule(meta.init, meta.hints, meta.descriptions, defaultArgs),
    })
  }

  // Modules with EXTRA_INFO → one service per row, for each country that lists the module.
  const modulesWithExtra = new Set<string>()
  for (const [module, meta] of moduleMeta) {
    if (meta.extra.length === 0) continue
    modulesWithExtra.add(module)
    const countries = byCountry.get(module) ?? []
    const countryIds =
      countries.length > 0
        ? countries.map((c) => countryIdOf(c))
        : meta.extra.some((e) => e.country)
          ? [
              ...new Set(
                meta.extra
                  .map((e) => e.country)
                  .filter((c): c is string => typeof c === 'string')
                  .map((c) => countryIdOf(c.length === 2 ? c.toUpperCase() : c)),
              ),
            ]
          : ['generic']

    // Map short ISO-ish country on EXTRA_INFO to catalog country ids when possible
    const resolveCountryIds = (row: ExtraInfoRow): string[] => {
      if (row.country === 'it') return countryIds.includes('italy') ? ['italy'] : countryIds
      if (row.country === 'de') return countryIds.includes('germany') ? ['germany'] : countryIds
      if (row.country) {
        const id = countryIdOf(row.country)
        return countryLabels.has(id) ? [id] : countryIds
      }
      return countryIds
    }

    for (const row of meta.extra) {
      for (const cid of resolveCountryIds(row)) {
        if (!countryLabels.has(cid) && cid !== 'generic') {
          // Infer label from id
          countryLabels.set(cid, cid === 'italy' ? 'Italy' : cid === 'germany' ? 'Germany' : cid)
        }
        pushService(cid, row.title, module, { ...row.defaultParams })
      }
    }
  }

  // README bullets for modules without EXTRA_INFO
  for (const b of bullets) {
    if (modulesWithExtra.has(b.module)) continue
    pushService(countryIdOf(b.countryLabel), b.label, b.module, {})
  }

  // Modules never in README still appear as a single generic service (e.g. example)
  for (const module of modules) {
    if ((byCountry.get(module) ?? []).length > 0) continue
    if (modulesWithExtra.has(module)) continue
    const meta = moduleMeta.get(module)
    if (!meta) continue
    if (!countryLabels.has('generic')) countryLabels.set('generic', 'ICS / generic')
    pushService('generic', meta.title, module, {})
  }

  const countries: CatalogCountry[] = [...countryLabels.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label))

  services.sort((a, b) => {
    const c = a.countryId.localeCompare(b.countryId)
    if (c !== 0) return c
    return a.label.localeCompare(b.label)
  })

  return {
    generatedAt: new Date().toISOString(),
    sourceHash: hash.digest('hex'),
    entries,
    countries,
    services,
  }
}

export function listVendorModules(): readonly string[] {
  return listSourceModules()
}

function main(): void {
  const catalog = buildCatalog()
  writeFileSync(OUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `wrote ${catalog.entries.length} modules, ${catalog.countries.length} countries, ${catalog.services.length} services → ${OUT_PATH} (hash ${catalog.sourceHash.slice(0, 12)}…)\n`,
  )
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) main()
