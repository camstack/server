#!/usr/bin/env tsx
/**
 * One-shot operator repair for a pair of devices that `deviceManager.migrateDevice`
 * swapped BEFORE the fix that keeps secrets and location on their own number
 * (D339 amendment): the hardware config crossed, but each number's keychain
 * scope (`secret://<owner>/device/<id>/...`) and the room stayed or moved the
 * wrong way.
 *
 *   npx tsx scripts/hub/repair-migration-pair.ts --server <host> --a <id> --b <id>
 *        [--location-a <name|none>] [--location-b <name|none>] [--apply]
 *
 * - Secrets: `deviceManager.repairMigrationSecrets` re-points each number's
 *   markers at its OWN scope and exchanges the keychain values (admin only,
 *   keychain first). Idempotent: a repaired pair answers `nothing-to-repair`.
 * - Location: the room each number SHOULD have is stated by the operator
 *   (`--location-a`, `--location-b`; `none` clears it). Only a number whose
 *   room differs is written, so a second run changes nothing. Omitted = untouched.
 *
 * Dry run by default; `--apply` writes. `--server` is REQUIRED. Hub admin API
 * only (hub.mjs); no SQLite file is opened. Prints counts and refs, never a value.
 */
import * as path from 'node:path'
import { type HubCall, hubMjsCall } from './hub-call.js'

export interface RepairArgs {
  readonly server: string
  readonly apply: boolean
  readonly a: number
  readonly b: number
  /** undefined = leave alone; null = clear; string = that room. */
  readonly locationA: string | null | undefined
  readonly locationB: string | null | undefined
}

export function parseArgs(argv: readonly string[]): RepairArgs | string {
  const valueOf = (name: string): string | null => {
    const at = argv.indexOf(name)
    return at === -1 ? null : (argv[at + 1] ?? null)
  }
  const server = valueOf('--server')
  if (server === null || server.length === 0) {
    return 'refusing to run: --server <host> is REQUIRED (this script never picks a hub for you)'
  }
  const a = Number(valueOf('--a'))
  const b = Number(valueOf('--b'))
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) {
    return 'refusing to run: --a <id> and --b <id> must be two different device ids'
  }
  const location = (name: string): string | null | undefined => {
    const v = valueOf(name)
    if (v === null) return undefined
    return v === 'none' ? null : v
  }
  return {
    server,
    apply: argv.includes('--apply'),
    a,
    b,
    locationA: location('--location-a'),
    locationB: location('--location-b'),
  }
}

export interface LocationWrite {
  readonly deviceId: number
  readonly from: string | null
  readonly to: string | null
}

/** The writes that bring each number to its stated room; nothing for a number already there. */
export function planLocations(
  current: ReadonlyMap<number, string | null>,
  wanted: ReadonlyMap<number, string | null | undefined>,
): readonly LocationWrite[] {
  const out: LocationWrite[] = []
  for (const [deviceId, to] of wanted) {
    if (to === undefined) continue
    const from = current.get(deviceId) ?? null
    if (from !== to) out.push({ deviceId, from, to })
  }
  return out
}

function locationOf(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) {
    throw new Error('unexpected answer: device not found')
  }
  const raw: unknown = Reflect.get(answer, 'location')
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function outcomeOf(answer: unknown): string {
  if (typeof answer !== 'object' || answer === null) throw new Error('unexpected answer: empty')
  const raw: unknown = Reflect.get(answer, 'outcome')
  if (typeof raw !== 'string') throw new Error('unexpected answer: no outcome')
  return raw
}

export async function runRepair(hub: HubCall, args: RepairArgs): Promise<readonly string[]> {
  const lines: string[] = []
  const secrets = await hub.mutate('deviceManager.repairMigrationSecrets', {
    deviceA: args.a,
    deviceB: args.b,
    apply: args.apply,
  })
  const outcome = outcomeOf(secrets)
  lines.push(`secrets: ${outcome}`)
  const current = new Map<number, string | null>()
  for (const id of [args.a, args.b]) {
    current.set(id, locationOf(await hub.query('deviceManager.getDevice', { deviceId: id })))
  }
  const writes = planLocations(
    current,
    new Map([
      [args.a, args.locationA],
      [args.b, args.locationB],
    ]),
  )
  for (const w of writes) {
    if (args.apply) {
      await hub.mutate('deviceManager.setLocation', { deviceId: w.deviceId, location: w.to })
    }
    lines.push(
      `location: device ${w.deviceId} ${args.apply ? 'set' : 'would set'} ` +
        `${w.from ?? '(none)'} -> ${w.to ?? '(none)'}`,
    )
  }
  if (writes.length === 0) lines.push('location: nothing to change')
  return lines
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    console.error(args)
    process.exit(2)
  }
  console.log(args.apply ? 'APPLY: repairing the pair' : 'DRY RUN: nothing changes')
  for (const line of await runRepair(hubMjsCall(args.server), args)) {
    console.log(line)
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')
) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
