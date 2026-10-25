#!/usr/bin/env tsx
/**
 * One-shot operator script (D878, D880): move the secrets that sat in plain text
 * in SQLite into the keychain.
 *
 *   `ai:llm-profiles`  apiKey       -> secret://ai/row/ai:llm-profiles/<profileId>/apiKey
 *   `user_totp`        secret       -> secret://system/row/user_totp/<userId>/secret
 *   core-block settings (password fields a user script declares), and the
 *   redundant `core-blocks:settings` copy of them is deleted (D880)
 *   waste-collections `sources[].argsJson` credentials, rewritten as typed
 *   `args` with the credential as a marker (D880)
 *
 * Each OWNER does its own move through its own write path: this script only
 * calls `llm.migrateRawSecrets`, `userManagement.migrateRawSecrets`,
 * `coreBlocks.migrateRawSecrets` and the waste-collections `migrateSources`
 * action (through `addons.custom`). Per row
 * the owner puts the value in the keychain, reads it back, and only then
 * rewrites the row with the marker - the plaintext is cleared by the verified
 * move and nowhere else. Nothing runs at boot (no boot purge).
 *
 *   npx tsx scripts/hub/migrate-raw-secrets.ts --server <host>           # dry run
 *   npx tsx scripts/hub/migrate-raw-secrets.ts --server <host> --apply
 *   (optional) --token-file <f>
 *
 * Dry run by default. Idempotent: a second `--apply` finds nothing raw. Exits 1
 * when, after the run, any row is still raw or any marker does not resolve.
 *
 * Prints COUNTS only, never a value or a ref. `--server` is REQUIRED: this
 * script never picks a hub for you. Through the hub's admin API
 * (`scripts/hub/hub.mjs`); no SQLite file is opened (D679).
 *
 * REMOVE THIS SCRIPT (and the `migrateRawSecrets` / `migrateSources` methods) once every
 * hub ran `--apply` and verified.
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'

export interface HubMutate {
  mutate(route: string, input: unknown): Promise<unknown>
}

/** One owner's migration: the route to call and the input it takes for a given `apply`. */
export interface OwnerRoute {
  readonly label: string
  readonly route: string
  readonly input: (apply: boolean) => unknown
}

const applyOnly = (apply: boolean): { readonly apply: boolean } => ({ apply })

/** The routes of the owners, in the order they run. */
export const OWNER_ROUTES: readonly OwnerRoute[] = [
  { label: 'llm profile apiKey', route: 'llm.migrateRawSecrets', input: applyOnly },
  { label: 'totp seed', route: 'userManagement.migrateRawSecrets', input: applyOnly },
  { label: 'core block password', route: 'coreBlocks.migrateRawSecrets', input: applyOnly },
  {
    label: 'waste source credential',
    route: 'addons.custom',
    input: (apply) => ({
      addonId: 'waste-collections',
      action: 'migrateSources',
      input: { apply },
    }),
  },
]

export interface OwnerResult {
  readonly label: string
  readonly rows: number
  readonly raw: number
  readonly markers: number
  readonly migrated: number
  readonly failed: number
  readonly remainingRaw: number
  readonly unresolvedMarkers: number
  /** A second copy found (and, on apply, deleted after the first was verified); null when the owner keeps one. */
  readonly redundantCopies: number | null
  readonly verified: boolean
}

function num(value: unknown, field: string): number {
  if (typeof value !== 'number') throw new Error(`unexpected answer: ${field} is not a number`)
  return value
}

/** Take an owner's answer apart, field by field - an unexpected shape is an error, not a guess. */
export function parseReport(label: string, answer: unknown): OwnerResult {
  if (typeof answer !== 'object' || answer === null) throw new Error(`${label}: empty answer`)
  const get = (field: string): unknown => Reflect.get(answer, field)
  return {
    label,
    rows: num(get('rows'), 'rows'),
    raw: num(get('raw'), 'raw'),
    markers: num(get('markers'), 'markers'),
    migrated: num(get('migrated'), 'migrated'),
    failed: num(get('failed'), 'failed'),
    remainingRaw: num(get('remainingRaw'), 'remainingRaw'),
    unresolvedMarkers: num(get('unresolvedMarkers'), 'unresolvedMarkers'),
    redundantCopies:
      get('redundantCopies') === undefined ? null : num(get('redundantCopies'), 'redundantCopies'),
    verified: get('verified') === true,
  }
}

export async function runMigration(hub: HubMutate, apply: boolean): Promise<OwnerResult[]> {
  const out: OwnerResult[] = []
  for (const { label, route, input } of OWNER_ROUTES) {
    out.push(parseReport(label, await hub.mutate(route, input(apply))))
  }
  return out
}

export function formatResult(r: OwnerResult, apply: boolean): string {
  const moved = apply ? `migrated ${r.migrated}, failed ${r.failed}` : `would migrate ${r.raw}`
  const copies =
    r.redundantCopies === null
      ? ''
      : `; redundant copies ${apply ? 'found' : 'would be removed'} ${r.redundantCopies}`
  return (
    `${r.label}: rows ${r.rows}, raw ${r.raw}, already markers ${r.markers}; ${moved}${copies}; ` +
    `after: raw ${r.remainingRaw}, unresolved markers ${r.unresolvedMarkers}, verified ${r.verified ? 'yes' : 'no'}`
  )
}

/** The run is good when nothing is raw and every marker resolves. */
export function allVerified(results: readonly OwnerResult[]): boolean {
  return results.every((r) => r.verified)
}

export interface CliArgs {
  readonly server: string
  readonly tokenFile: string | null
  readonly apply: boolean
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
  return { server, tokenFile: valueOf('--token-file'), apply: argv.includes('--apply') }
}

/** One call to the real hub, through hub.mjs; the input goes on STDIN. */
export type HubCall = (route: string, input: unknown) => Promise<unknown>

/** The real hub, through hub.mjs, with the HTTP method of the route (query = GET, mutation = POST). */
export function hubMjsCall(
  server: string,
  tokenFile: string | null,
  method: 'GET' | 'POST',
): HubCall {
  const script = path.join(import.meta.dirname ?? __dirname, 'hub.mjs')
  const extra = ['--server', server, ...(tokenFile === null ? [] : ['--token-file', tokenFile])]
  return (route, input) =>
    new Promise((resolve, reject) => {
      const child = spawn('node', [script, ...extra, method, route, '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (c: Buffer) => out.push(c))
      child.stderr.on('data', (c: Buffer) => err.push(c))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(Buffer.concat(err).toString('utf-8').trim() || `hub.mjs exited ${code}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(out).toString('utf-8')) as unknown)
        } catch (e: unknown) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
      child.stdin.end(JSON.stringify(input))
    })
}

export function hubMjsMutate(server: string, tokenFile: string | null): HubMutate {
  return { mutate: hubMjsCall(server, tokenFile, 'POST') }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    console.error(args)
    process.exit(2)
  }
  console.log(
    args.apply ? 'APPLY: moving plaintext secrets into the keychain' : 'DRY RUN: nothing changes',
  )
  const results = await runMigration(hubMjsMutate(args.server, args.tokenFile), args.apply)
  for (const r of results) console.log(formatResult(r, args.apply))
  if (!allVerified(results)) {
    console.error(
      args.apply
        ? 'NOT verified: some rows are still raw or some markers do not resolve (is the keychain locked?).'
        : 'Not verified yet: re-run with --apply to move what is raw.',
    )
    process.exit(1)
  }
  console.log('verified: every row holds a marker and every marker resolves')
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
