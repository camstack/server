/**
 * `camstack watch [path]` — deploy + tail server-side logs of the
 * deployed addon. The CLI uses the scoped-token route-prefix scope
 * `/trpc/addons.getLogs` to poll the tRPC endpoint every 2 seconds
 * and prints new entries since the last cursor.
 *
 * Relationship to siblings:
 *   • `deploy` = one-shot push + restart (no follow-up).
 *   • `watch`  = deploy + log streaming (this file).
 *   • `dev`    = deploy + file-watch + auto-redeploy (commands/dev.ts).
 *
 * All three share the initial deploy step (the server-side install
 * already calls `reloadPackages()` which restarts the addon).
 */
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import * as clack from '@clack/prompts'
import {
  type CredentialSource,
  loadSession,
  touchSession,
  resolveFreshCredentials,
  withAuthHint,
} from '@camstack/develop'
import { cliHubTransport } from '../http/hub-transport.js'
import { deployAddon, resolveAddonPathInteractive, type DeployOptions } from './deploy.js'
import { hubRequest } from '../http/hub-http.js'

const POLL_INTERVAL_MS = 2_000
const LOG_BATCH_LIMIT = 100

interface LogEntry {
  readonly timestamp: number | string
  readonly level: string
  readonly scope?: readonly string[]
  readonly message: string
  readonly meta?: Record<string, unknown>
}

interface TrpcQueryResult<T> {
  readonly result?: { readonly data?: { readonly json?: T } }
}

const LEVEL_COLOURS: Record<string, string> = {
  debug: '[90m', // grey
  info: '[37m', // white
  warn: '[33m', // yellow
  error: '[31m', // red
}
const RESET = '[0m'

function fmtTs(ts: number | string): string {
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts)
  return d.toISOString().slice(11, 23) // HH:MM:SS.mmm
}

function fmtScope(scope: readonly string[] | undefined): string {
  if (!scope || scope.length === 0) return ''
  return ` [2m[${scope.join('.')}]${RESET}`
}

function printLine(e: LogEntry, addonId: string): void {
  const colour = LEVEL_COLOURS[e.level] ?? ''
  process.stdout.write(
    `${fmtTs(e.timestamp)} ${colour}${e.level.padEnd(5)}${RESET}${fmtScope(e.scope)} [2m${addonId}${RESET} ${e.message}\n`,
  )
}

/**
 * One round of polling. Uses tRPC GET form (input encoded in query
 * string) since `addons.getLogs` is a query. Returns the entries +
 * the high-water timestamp for the next round's cursor.
 */
async function fetchLogs(
  server: string,
  token: string,
  addonId: string,
  limit: number,
  authSource?: CredentialSource,
): Promise<readonly LogEntry[]> {
  const input = encodeURIComponent(JSON.stringify({ json: { addonId, limit } }))
  const url = `${server}/trpc/addons.getLogs?input=${input}`
  const res = await hubRequest(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      withAuthHint(`getLogs HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, authSource),
    )
  }
  const body = (await res.json()) as TrpcQueryResult<readonly LogEntry[]>
  return body.result?.data?.json ?? []
}

export async function runWatch(args: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      server: { type: 'string', short: 's' },
      token: { type: 'string', short: 't' },
      'token-file': { type: 'string' },
      node: { type: 'string', short: 'n' },
      cluster: { type: 'boolean', short: 'c' },
      'no-build': { type: 'boolean' },
      'build-script': { type: 'string' },
      level: { type: 'string', short: 'l' },
      'no-initial-deploy': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: true,
  })

  // Resolve auth + path. Same chain as deploy/dev — kept inline so each
  // command stays self-contained.
  const addonArg = positionals[0] ?? '.'
  const credentialInputs = {
    ...(typeof values.server === 'string' ? { server: values.server } : {}),
    ...(typeof values.token === 'string' ? { token: values.token } : {}),
    ...(typeof values['token-file'] === 'string' ? { tokenFile: values['token-file'] } : {}),
    loadSession,
    transport: cliHubTransport,
  }
  const creds = await resolveFreshCredentials(credentialInputs)
  if (creds.warning) console.error(`[camstack watch] Warning: ${creds.warning}`)
  if (creds.source === 'session' && creds.server) touchSession(creds.server)
  const serverUrl = creds.server
  const token = creds.token
  if (!serverUrl) {
    throw new Error('No hub server known. Pass --server, or run `camstack login` first.')
  }
  const nodeId = typeof values.node === 'string' ? values.node : undefined
  const cluster = values.cluster === true
  const deployOpts: DeployOptions = {
    serverUrl,
    token,
    authSource: creds.source,
    ...(nodeId ? { nodeId } : {}),
    ...(cluster ? { cluster: true } : {}),
    buildMode: values['no-build'] === true ? 'skip' : 'auto',
    ...(typeof values['build-script'] === 'string' ? { buildScript: values['build-script'] } : {}),
  }

  clack.intro('camstack watch')

  // Resolve the addon path early so we know what addonId to subscribe to.
  const resolvedPath = await resolveAddonPathInteractive(addonArg)
  const addonId = path.basename(resolvedPath).replace(/^addon-/, '')

  // Initial deploy unless the operator wants to just tail an existing addon.
  if (values['no-initial-deploy'] !== true) {
    await deployAddon(resolvedPath, deployOpts)
  }

  clack.log.info(`Tailing logs for "${addonId}" — Ctrl-C to stop.`)
  console.log('')

  // Poll loop. We seed `seenIds` from the first round so we don't
  // dump the entire 100-entry backlog; subsequent polls only print
  // entries whose timestamp is newer than the last we saw.
  const seenKeys = new Set<string>()
  let firstRound = true
  let stop = false
  const shutdown = (): void => {
    stop = true
    console.log('\n[camstack watch] Stopped.')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // `stop` is flipped by the SIGINT/SIGTERM `shutdown` handler, which runs
  // during the `await fetchLogs` yield below — not in the loop body itself.
  // eslint-disable-next-line no-unmodified-loop-condition
  while (!stop) {
    try {
      // Re-resolved every round: a long tail outlives an access token.
      const fresh = await resolveFreshCredentials(credentialInputs)
      const entries = await fetchLogs(
        serverUrl,
        fresh.token,
        addonId,
        LOG_BATCH_LIMIT,
        creds.source,
      )
      // Newest-last ordering for printing. The server returns newest-first
      // historically; we don't depend on order — we dedupe by composite key.
      const sorted = [...entries].toSorted((a, b) => {
        const ta = typeof a.timestamp === 'number' ? a.timestamp : new Date(a.timestamp).getTime()
        const tb = typeof b.timestamp === 'number' ? b.timestamp : new Date(b.timestamp).getTime()
        return ta - tb
      })
      for (const e of sorted) {
        if (values.level && e.level !== values.level) continue
        const ts = typeof e.timestamp === 'number' ? e.timestamp : new Date(e.timestamp).getTime()
        const key = `${ts}|${e.level}|${e.message}`
        if (seenKeys.has(key)) continue
        seenKeys.add(key)
        if (!firstRound) printLine(e, addonId)
      }
      if (firstRound) {
        // Print only the last 20 entries on initial fetch so the operator
        // has context without a full backlog dump.
        const tail = sorted.slice(-20)
        for (const e of tail) {
          if (values.level && e.level !== values.level) continue
          printLine(e, addonId)
        }
        firstRound = false
      }
      // Cap memory — keep last 1000 keys, drop the earliest beyond that.
      if (seenKeys.size > 1000) {
        const arr = Array.from(seenKeys)
        seenKeys.clear()
        arr.slice(-500).forEach((k) => seenKeys.add(k))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[camstack watch] poll error: ${msg}`)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}
