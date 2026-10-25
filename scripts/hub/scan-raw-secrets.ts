#!/usr/bin/env tsx
/**
 * Read-only operator scan (D880): where does a credential-named field still hold
 * a plain string in the live settings database?
 *
 *   npx tsx scripts/hub/scan-raw-secrets.ts --server <host>
 *   (optional) --token-file <f>  --max-rows <n>  --page <n>  --pause-ms <n>  --json
 *
 * It walks EVERY table the hub lists (`storageAdmin.listTables`) through the read
 * API (`settingsStore.query`, paged, ordered by id) and reports, per finding,
 * the SHAPE only: owner, collection, row id and field path. A finding is a
 * credential-named field (the `check-secret-fields-declared` name heuristic, used
 * only to FIND candidates) holding a non-empty string that is not a keychain
 * marker. Because it reads the rows and not the code, it also finds the ones no
 * code writes any more (orphans: a legacy `brokers[]` row that outlived its
 * migration), which the static guards cannot see.
 *
 * It NEVER prints or logs a value: the walk produces `{ table, rowId, path }`
 * and nothing that carries the string; an error is reported by its class and the
 * table, never its message. A row's `{ key, value }` pair (an `addon-settings`
 * row stores the field NAME in `key`) is reported as the path of the name.
 *
 * Read-only: only `GET` routes, one page at a time with a pause between pages, a
 * row ceiling per table (`--max-rows`, default 20000; a larger table is listed as
 * skipped, never silently dropped). `--server` is REQUIRED - this script never
 * picks a hub for you. Exit 1 when any finding exists, 2 on a usage error.
 *
 * It is a step of the records adoption dry run (D880): run it before adopting a
 * collection into `ctx.records`, and again after the migration.
 */
import * as path from 'node:path'
import { CREDENTIAL_NAME } from '../check-secret-fields-declared.ts'
import { LEFTOVER_ROW_IDS } from './entries-leftover-targets.js'
import { type HubCall, hubMjsCall } from './migrate-raw-secrets.ts'

export interface TableInfo {
  readonly name: string
  readonly rows: number
}

export interface Finding {
  readonly table: string
  readonly rowId: string
  readonly path: string
}

export interface SkippedTable {
  readonly table: string
  readonly reason: 'too-large' | 'unreadable'
  readonly rows: number
}

export interface ScanReport {
  readonly tables: number
  readonly rowsScanned: number
  readonly findings: readonly Finding[]
  readonly skipped: readonly SkippedTable[]
}

export interface ScanOptions {
  readonly maxRows: number
  readonly page: number
  readonly pauseMs: number
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = { maxRows: 20_000, page: 500, pauseMs: 50 }

/** Names that look like a credential but never HOLD one: hashes, counters, labels, ids. */
const NOT_A_VALUE_SUFFIX =
  /(hash|hashed|fingerprint|count|length|expires|expiresat|expiry|type|kind|version|status|label|ref|path|id|name)$/i

const MAX_DEPTH = 8

/** The canonical bases a `<namespace>:<base>` table name can carry. */
const NAMESPACED_BASES: readonly string[] = [
  'addon-settings',
  'addon-devices',
  'addon-device-settings',
  'sections',
  'device-runtime-state',
  'provider-settings',
  'device-settings',
  'alerts',
  'system-settings',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMarkerShape(value: unknown): boolean {
  return isRecord(value) && typeof value['$secret'] === 'string'
}

function looksLikeCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name) && !NOT_A_VALUE_SUFFIX.test(name)
}

/** A string that is JSON text of an object or array is walked as that structure. */
function asStructure(value: string): unknown {
  const first = value.trimStart()[0]
  if (first !== '{' && first !== '[') return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function isRawString(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  return !isMarkerShape(asStructure(value))
}

/**
 * Every path under `value` where a credential-named field holds a raw string.
 * Returns PATHS only - the strings it inspected are never copied out.
 */
export function rawSecretPaths(value: unknown, prefix = '', depth = 0): string[] {
  if (depth > MAX_DEPTH) return []
  if (typeof value === 'string') {
    const inner = asStructure(value)
    return inner === undefined ? [] : rawSecretPaths(inner, prefix, depth + 1)
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => rawSecretPaths(item, `${prefix}[${i}]`, depth + 1))
  }
  if (!isRecord(value) || isMarkerShape(value)) return []
  const out: string[] = []
  // `{ key|name: <credential name>, value: <string> }` - the shape of an
  // addon-settings row and of a header list: the NAME is a sibling of the value.
  for (const nameField of ['key', 'name']) {
    const named = value[nameField]
    if (
      typeof named === 'string' &&
      looksLikeCredentialName(named) &&
      isRawString(value['value'])
    ) {
      out.push(`${prefix}${prefix === '' ? '' : '.'}value (${nameField}-named pair)`)
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const at = `${prefix}${prefix === '' ? '' : '.'}${key}`
    if (looksLikeCredentialName(key) && isRawString(child)) out.push(at)
    else out.push(...rawSecretPaths(child, at, depth + 1))
  }
  return out
}

/** `ns:addon-settings` -> its namespace + base; any other name is a collection of its own. */
export function splitTable(name: string): { namespace?: string; collection: string } {
  const at = name.indexOf(':')
  if (at > 0) {
    const base = name.slice(at + 1)
    if (NAMESPACED_BASES.includes(base)) return { namespace: name.slice(0, at), collection: base }
  }
  return { collection: name }
}

function parseTables(answer: unknown): TableInfo[] {
  const tables = isRecord(answer) ? answer['tables'] : undefined
  if (!Array.isArray(tables)) throw new Error('storageAdmin.listTables: unexpected answer shape')
  return tables.flatMap((t): TableInfo[] => {
    if (!isRecord(t)) return []
    const name = t['name']
    const rows = t['rows']
    return typeof name === 'string' && typeof rows === 'number' ? [{ name, rows }] : []
  })
}

function parseRecords(answer: unknown): { id: string; data: unknown }[] {
  if (!Array.isArray(answer)) throw new Error('settingsStore.query: unexpected answer shape')
  return answer.flatMap((r) => {
    if (!isRecord(r) || typeof r['id'] !== 'string') return []
    return [{ id: r['id'], data: r['data'] }]
  })
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))

/** Page one table. Throws on a read failure; the caller reports it by table only. */
async function scanTable(
  call: HubCall,
  table: TableInfo,
  opts: ScanOptions,
): Promise<{ rows: number; findings: Finding[] }> {
  const target = splitTable(table.name)
  const findings: Finding[] = []
  let rows = 0
  for (let offset = 0; ; offset += opts.page) {
    const answer = await call('settingsStore.query', {
      ...target,
      filter: { orderBy: { field: 'id', direction: 'asc' }, limit: opts.page, offset },
    })
    const page = parseRecords(answer)
    rows += page.length
    for (const row of page) {
      for (const p of rawSecretPaths(row.data)) {
        findings.push({ table: table.name, rowId: row.id, path: p })
      }
    }
    if (page.length < opts.page) return { rows, findings }
    await sleep(opts.pauseMs)
  }
}

/**
 * The records engine's tables (D881). A record kind cannot hold a plaintext
 * secret: the engine refuses anything but a keychain marker at a secret path,
 * so there is nothing for this scan to find there - and the tables are not
 * readable through the collection door anyway.
 */
const RECORDS_ENGINE_TABLES: readonly string[] = ['records', '_record_kinds', '_record_sequences']

export async function scanHub(
  call: HubCall,
  opts: ScanOptions = DEFAULT_SCAN_OPTIONS,
): Promise<ScanReport> {
  const tables = parseTables(await call('storageAdmin.listTables', {})).filter(
    (t) => !RECORDS_ENGINE_TABLES.includes(t.name),
  )
  const findings: Finding[] = []
  const skipped: SkippedTable[] = []
  let rowsScanned = 0
  for (const table of tables) {
    if (table.rows > opts.maxRows) {
      skipped.push({ table: table.name, reason: 'too-large', rows: table.rows })
      continue
    }
    try {
      const result = await scanTable(call, table, opts)
      rowsScanned += result.rows
      findings.push(...result.findings)
    } catch {
      // The error text is NOT carried: it could echo a row.
      skipped.push({ table: table.name, reason: 'unreadable', rows: table.rows })
    }
  }
  return { tables: tables.length, rowsScanned, findings, skipped }
}

/** The human report: shapes, grouped by table. */
export function formatReport(report: ScanReport): string[] {
  const lines = [
    `tables ${report.tables}, rows scanned ${report.rowsScanned}, ` +
      `findings ${report.findings.length}, skipped ${report.skipped.length}`,
  ]
  const byTable = new Map<string, Finding[]>()
  for (const f of report.findings) byTable.set(f.table, [...(byTable.get(f.table) ?? []), f])
  for (const [table, list] of byTable) {
    lines.push(`RAW  ${table}: ${list.length} field(s)`)
    for (const f of list) lines.push(`       row ${f.rowId}  ${f.path}`)
  }
  for (const s of report.skipped) {
    lines.push(`SKIP ${s.table}: ${s.reason} (rows ${s.rows}) - NOT checked`)
  }
  lines.push(
    report.findings.length === 0
      ? report.skipped.length === 0
        ? 'clean: no credential-named field holds a raw string'
        : 'no raw field in what was scanned; the skipped tables were NOT checked'
      : 'RAW credential-named fields found: see above (shapes only, no value is printed)',
  )
  const censusOrphans = report.findings.filter((f) => LEFTOVER_ROW_IDS.has(f.rowId))
  if (censusOrphans.length > 0) {
    lines.push(
      `entries census X: ${censusOrphans.length} finding(s) on known orphan row id(s) — ` +
        'delete with scripts/hub/delete-entries-leftovers.ts after verify (B0)',
    )
  }
  return lines
}

export interface CliArgs {
  readonly server: string
  readonly tokenFile: string | null
  readonly json: boolean
  readonly options: ScanOptions
}

export function parseArgs(argv: readonly string[]): CliArgs | string {
  const valueOf = (name: string): string | null => {
    const at = argv.indexOf(name)
    return at === -1 ? null : (argv[at + 1] ?? null)
  }
  const server = valueOf('--server')
  if (server === null || server.length === 0) {
    return 'refusing to run: --server <host> is REQUIRED (this script never picks a hub for you)'
  }
  const number = (name: string, fallback: number): number | string => {
    const raw = valueOf(name)
    if (raw === null) return fallback
    const n = Number(raw)
    return Number.isInteger(n) && n >= 0 ? n : `${name} must be a non-negative integer`
  }
  const maxRows = number('--max-rows', DEFAULT_SCAN_OPTIONS.maxRows)
  const page = number('--page', DEFAULT_SCAN_OPTIONS.page)
  const pauseMs = number('--pause-ms', DEFAULT_SCAN_OPTIONS.pauseMs)
  for (const v of [maxRows, page, pauseMs]) if (typeof v === 'string') return v
  if (typeof maxRows !== 'number' || typeof page !== 'number' || typeof pauseMs !== 'number') {
    return 'invalid numeric option'
  }
  if (page < 1) return '--page must be at least 1'
  return {
    server,
    tokenFile: valueOf('--token-file'),
    json: argv.includes('--json'),
    options: { maxRows, page, pauseMs },
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    console.error(args)
    process.exit(2)
  }
  const report = await scanHub(hubMjsCall(args.server, args.tokenFile, 'GET'), args.options)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else for (const line of formatReport(report)) console.log(line)
  if (report.findings.length > 0) process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')
) {
  main().catch((err: unknown) => {
    // Only the table listing can reach here (a table's own failure is caught per
    // table and never carries its text), and that call returns no row.
    console.error(`scan failed: ${err instanceof Error ? err.message : 'error'}`)
    process.exit(1)
  })
}
