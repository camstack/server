#!/usr/bin/env tsx
/**
 * One-off operator step (planning#460): give every remote layout template a
 * `source_select` key on a new first row, so the source picker appears on
 * remotes that already exist. A template that already has the key is skipped.
 *
 *   npx tsx scripts/remote/add-source-select-row.ts --server <host>                         # dry run (default)
 *   npx tsx scripts/remote/add-source-select-row.ts --server <host> --apply --backup <file>
 *   (optional) --token-file <f>
 *
 * `--apply` first writes the ORIGINAL payloads of the templates it will change
 * to `--backup <file>` (JSON) and refuses to run without it. Reaches the hub
 * only through `scripts/hub/hub.mjs` (its credential chain: `camstack login`);
 * no password or token is read or printed here.
 */
import { writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { type HubCall, hubMjsCall } from '../hub/hub-call.js'
import { planSourceSelectRow, type SourceSelectRowPlan } from './source-select-row.js'

interface TemplateRow {
  readonly id: string
  readonly name: string
  readonly payload: unknown
}

export interface CliArgs {
  readonly server: string
  readonly tokenFile: string | null
  readonly apply: boolean
  readonly backup: string | null
}

export function parseArgs(argv: readonly string[]): CliArgs | string {
  const valueOf = (name: string): string | null => {
    const at = argv.indexOf(name)
    return at === -1 ? null : (argv[at + 1] ?? null)
  }
  const server = valueOf('--server')
  if (server === null) return 'refusing to run: --server <host> is REQUIRED'
  const apply = argv.includes('--apply')
  const backup = valueOf('--backup')
  if (apply && backup === null) return 'refusing to run: --apply needs --backup <file>'
  return { server, tokenFile: valueOf('--token-file'), apply, backup }
}

function isRow(value: unknown): value is TemplateRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'payload' in value
  )
}

export interface PlannedTemplate {
  readonly row: TemplateRow
  readonly plan: SourceSelectRowPlan
}

export async function planTemplates(hub: HubCall): Promise<readonly PlannedTemplate[]> {
  const rows = await hub.query('template.list', { kind: 'remote' })
  if (!Array.isArray(rows)) throw new Error('template.list did not answer a list')
  return rows.filter(isRow).map((row) => ({ row, plan: planSourceSelectRow(row.payload) }))
}

function describe(p: PlannedTemplate): string {
  const head = `${p.row.id} "${p.row.name}"`
  switch (p.plan.status) {
    case 'already-present':
      return `skip   ${head}: already has source_select`
    case 'refused':
      return `refuse ${head}: ${p.plan.reason}`
    case 'insert':
      return `insert ${head}: rows ${p.plan.layout.rows - 1} -> ${p.plan.layout.rows}`
  }
}

export interface ApplyResult {
  readonly updated: number
  readonly failed: number
}

/**
 * Writes the backup of the ORIGINAL payloads first, then updates each planned
 * template. A refused (or throwing) update is a failure, reported by name; the
 * others still run.
 */
export async function applyPlan(
  hub: HubCall,
  planned: readonly PlannedTemplate[],
  backupFile: string,
  log: (line: string) => void = console.log,
): Promise<ApplyResult> {
  const todo = planned.filter((p) => p.plan.status === 'insert')
  if (todo.length === 0) return { updated: 0, failed: 0 }
  writeFileSync(
    path.resolve(backupFile),
    JSON.stringify(
      todo.map((p) => ({ id: p.row.id, name: p.row.name, payload: p.row.payload })),
      null,
      2,
    ),
    { mode: 0o600 },
  )
  log(`backup written: ${path.resolve(backupFile)}`)
  let updated = 0
  let failed = 0
  for (const p of todo) {
    if (p.plan.status !== 'insert') continue
    try {
      const result = await hub.mutate('template.update', { id: p.row.id, payload: p.plan.layout })
      const status =
        typeof result === 'object' && result !== null && 'status' in result ? result.status : null
      if (status === 'saved') {
        updated += 1
        log(`updated ${p.row.id}`)
      } else {
        failed += 1
        log(`FAILED  ${p.row.id} "${p.row.name}": ${JSON.stringify(result)}`)
      }
    } catch (err: unknown) {
      failed += 1
      log(`FAILED  ${p.row.id} "${p.row.name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { updated, failed }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    console.error(args)
    process.exit(1)
  }
  const hub = hubMjsCall(args.server, args.tokenFile)
  const planned = await planTemplates(hub)
  for (const p of planned) console.log(describe(p))
  const todo = planned.filter((p) => p.plan.status === 'insert')
  console.log(`${todo.length} to change, ${planned.length - todo.length} left as they are`)
  if (!args.apply || args.backup === null) {
    console.log('dry run: nothing written (use --apply --backup <file>)')
    return
  }
  const result = await applyPlan(hub, planned, args.backup)
  console.log(`${result.updated} updated, ${result.failed} failed`)
  if (result.failed > 0) process.exitCode = 1
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')
) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
