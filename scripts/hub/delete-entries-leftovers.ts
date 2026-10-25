#!/usr/bin/env tsx
/**
 * One-shot operator script (B0 / entries census **X**): delete legacy
 * addon-settings rows no code reads any more (C10–C12, C14, N3).
 *
 *   npx tsx scripts/hub/delete-entries-leftovers.ts --server <host>           # dry run
 *   npx tsx scripts/hub/delete-entries-leftovers.ts --server <host> --apply
 *   (optional) --token-file <f>  --dreame-integration <id>   (default int_0009)
 *
 * C10: before deleting `provider-dreame.brokers`, confirms the dreame integration
 * (default `int_0009`) holds a keychain MARKER for `password` and that the marker
 * resolves through `keychainAdmin.reveal` — counts and shapes only, never a value.
 *
 * Other targets are deleted when the row exists (missing row = already clean).
 * Dry run by default. Idempotent. Through `scripts/hub/hub.mjs` only (D679).
 *
 * Run on `.50` first, then prod. After apply, re-run
 * `npx tsx scripts/hub/scan-raw-secrets.ts --server <host>` (should be clean of
 * these row ids).
 */
import * as path from 'node:path'
import { isSecretMarker } from '../../packages/types/src/keychain/secret-marker.js'
import { type HubCall, hubMjsCall } from './hub-call.js'
import {
  DREAME_INTEGRATION_ID,
  DREAME_LEGACY_BROKERS_KEY,
  LEFTOVER_ROW_TARGETS,
  type LeftoverRowTarget,
} from './entries-leftover-targets.js'

export interface DreameGateResult {
  readonly ok: boolean
  readonly reason: string
}

export interface RowOutcome {
  readonly target: LeftoverRowTarget
  readonly present: boolean
  readonly deleted: boolean
  readonly failed: boolean
}

export type DeleteLeftoversOutcome =
  | { readonly status: 'skipped'; readonly reason: string; readonly apply: boolean }
  | {
      readonly status: 'done'
      readonly apply: boolean
      readonly present: number
      readonly deleted: number
      readonly failed: number
      readonly rows: readonly RowOutcome[]
      readonly dreameGate?: DreameGateResult
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function markerRef(value: unknown): string | null {
  if (!isSecretMarker(value)) return null
  const ref = value['$secret']
  return typeof ref === 'string' && ref.length > 0 ? ref : null
}

/** C10 pre-check: integration password is a marker that resolves (value never logged). */
export async function verifyDreamePasswordMarker(
  hub: HubCall,
  integrationId: string,
): Promise<DreameGateResult> {
  const integration = await hub.query('integrations.get', { id: integrationId })
  if (!isRecord(integration)) {
    return { ok: false, reason: 'integration get did not answer' }
  }
  const addonId = integration['addonId'] ?? integration['addon_id']
  if (addonId !== 'provider-dreame') {
    return { ok: false, reason: `integration ${integrationId} is not provider-dreame` }
  }
  const settings = await hub.query('integrations.getSettings', { id: integrationId })
  if (!isRecord(settings)) {
    return { ok: false, reason: 'integration settings did not answer' }
  }
  const password = settings['password']
  const ref = markerRef(password)
  if (ref === null) {
    return { ok: false, reason: 'integration password is not a keychain marker' }
  }
  try {
    const revealed = await hub.mutate('keychainAdmin.reveal', { ref })
    if (!isRecord(revealed) || typeof revealed['value'] !== 'string') {
      return { ok: false, reason: 'marker did not resolve' }
    }
    if (revealed['value'].length === 0) {
      return { ok: false, reason: 'marker resolved empty' }
    }
  } catch {
    return { ok: false, reason: 'keychain reveal failed (locked or missing ref)' }
  }
  return { ok: true, reason: 'marker resolves' }
}

async function rowPresent(hub: HubCall, target: LeftoverRowTarget): Promise<boolean> {
  const answer = await hub.query('settingsStore.get', {
    collection: target.collection,
    key: target.key,
  })
  return answer !== null && answer !== undefined
}

export async function deleteEntriesLeftovers(
  hub: HubCall,
  opts: {
    readonly apply: boolean
    readonly dreameIntegrationId?: string
    readonly log?: (line: string) => void
  },
): Promise<DeleteLeftoversOutcome> {
  const log = opts.log ?? ((): void => {})
  const dreameId = opts.dreameIntegrationId ?? DREAME_INTEGRATION_ID
  const rows: RowOutcome[] = []
  let dreameGate: DreameGateResult | undefined

  const dreameTarget = LEFTOVER_ROW_TARGETS.find((t) => t.key === DREAME_LEGACY_BROKERS_KEY)
  const dreamePresent = dreameTarget !== undefined ? await rowPresent(hub, dreameTarget) : false

  if (dreamePresent) {
    dreameGate = await verifyDreamePasswordMarker(hub, dreameId)
    if (!dreameGate.ok && opts.apply) {
      log(`REFUSED — C10 gate: ${dreameGate.reason}`)
      return {
        status: 'skipped',
        reason: `C10 gate failed: ${dreameGate.reason}`,
        apply: opts.apply,
      }
    }
  }

  for (const target of LEFTOVER_ROW_TARGETS) {
    const present = await rowPresent(hub, target)
    if (!present) {
      rows.push({ target, present: false, deleted: false, failed: false })
      continue
    }
    if (!opts.apply) {
      rows.push({ target, present: true, deleted: false, failed: false })
      continue
    }
    if (target.key === DREAME_LEGACY_BROKERS_KEY && dreameGate !== undefined && !dreameGate.ok) {
      rows.push({ target, present: true, deleted: false, failed: true })
      continue
    }
    try {
      await hub.mutate('settingsStore.delete', {
        collection: target.collection,
        key: target.key,
      })
      rows.push({ target, present: true, deleted: true, failed: false })
    } catch (err: unknown) {
      log(
        `${target.censusId} ${target.key}: delete failed — ${err instanceof Error ? err.message : err}`,
      )
      rows.push({ target, present: true, deleted: false, failed: true })
    }
  }

  const present = rows.filter((r) => r.present).length
  const deleted = rows.filter((r) => r.deleted).length
  const failed = rows.filter((r) => r.failed).length
  return {
    status: 'done',
    apply: opts.apply,
    present,
    deleted,
    failed,
    rows,
    dreameGate,
  }
}

export interface CliArgs {
  readonly server: string
  readonly tokenFile: string | null
  readonly apply: boolean
  readonly dreameIntegrationId: string
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
  const dreame = valueOf('--dreame-integration')
  return {
    server,
    tokenFile: valueOf('--token-file'),
    apply: argv.includes('--apply'),
    dreameIntegrationId: dreame === null || dreame.length === 0 ? DREAME_INTEGRATION_ID : dreame,
  }
}

function formatRow(r: RowOutcome): string {
  const state = r.present
    ? r.deleted
      ? 'deleted'
      : r.failed
        ? 'FAILED'
        : 'would delete'
    : 'absent'
  return `${r.target.censusId}  ${r.target.key}  ${state}  (${r.target.note})`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    console.error(args)
    process.exit(2)
  }
  console.log(
    args.apply
      ? 'APPLY: deleting entries-census X addon-settings rows'
      : 'DRY RUN: counts only, nothing deleted',
  )
  const outcome = await deleteEntriesLeftovers(hubMjsCall(args.server, args.tokenFile), {
    apply: args.apply,
    dreameIntegrationId: args.dreameIntegrationId,
    log: (line) => console.log(line),
  })
  if (outcome.status === 'skipped') {
    console.error(outcome.reason)
    process.exit(1)
  }
  if (outcome.dreameGate !== undefined) {
    console.log(
      `C10 gate (${args.dreameIntegrationId}): ${outcome.dreameGate.ok ? 'ok' : 'NOT ok'} — ${outcome.dreameGate.reason}`,
    )
  }
  for (const row of outcome.rows) {
    if (row.present || !args.apply) console.log(formatRow(row))
  }
  console.log(
    `${args.apply ? 'APPLY' : 'DRY RUN'}: ${outcome.present} present, ${outcome.deleted} deleted, ${outcome.failed} failed`,
  )
  if (!args.apply && outcome.present > 0) {
    console.log('Re-run with --apply after the C10 gate reads ok.')
  }
  if (outcome.failed > 0 || (outcome.dreameGate !== undefined && !outcome.dreameGate.ok)) {
    process.exit(1)
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')
) {
  void main()
}
