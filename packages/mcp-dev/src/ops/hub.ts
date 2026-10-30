/**
 * The ops toolset's one doorway to the hub.
 *
 * Read-only BY CONSTRUCTION: {@link OpsHub} has a `query` and nothing else — no
 * `mutate`, no raw client — and every `query` passes {@link gateQuery}. A tool
 * that wants to write has no function to call.
 *
 * Credentials come from the shared chain in `@camstack/develop` (D835):
 * `--token-file`, then the `camstack login` session, renewed automatically
 * (one token format; only the permissions differ).
 * Nothing here reads a password, a `.pw`, or `$CAMSTACK_TOKEN`, and TLS is
 * pinned or the system store — never switched off.
 */
import {
  adminRejectedHint,
  connectHub,
  HubHttpError,
  HubRpcError,
  type CredentialSource,
  type CredentialTier,
  type HubClient,
  type HubConnectOptions,
  type HubConnection,
} from '@camstack/develop'
import type { ApiIndex } from '@camstack/develop'
import { createHubDownloader } from './download.js'
import { gateQuery } from '@camstack/develop'

/** The gate said no. The message is safe to show and says how to proceed. */
export class QueryRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryRefusedError'
  }
}

/** Streams one hub data-plane path to a local file; see `ops/download.ts`. */
export type HubDownloader = (
  urlPath: string,
  destFile: string,
  maxBytes: number,
) => Promise<{ readonly bytes: number }>

export interface OpsHub {
  readonly server: string
  readonly tier: CredentialTier
  readonly source: CredentialSource
  /**
   * Set when there is no usable admin credential (missing, expired): why, and the
   * exact command that creates one. `null` when the credential is admin and live.
   */
  readonly adminHint: string | null
  /** A gated GET of a generated `query` method. Throws {@link QueryRefusedError}. */
  query(methodPath: string, input?: unknown): Promise<unknown>
  /** A gated GET of an allow-listed data-plane path into a file. Read-only. */
  download(urlPath: string, destFile: string, maxBytes: number): Promise<{ readonly bytes: number }>
}

/**
 * The ONE doorway for a cluster mutation. It exists only when the server was
 * started with `--allow-mutations`, it is reachable only from a tool that went
 * through the `MutationGate`, and it refuses any method outside
 * {@link MUTATION_ALLOWLIST}.
 */
export interface OpsMutator {
  readonly server: string
  readonly tier: CredentialTier
  mutate(methodPath: string, input: unknown): Promise<unknown>
}

/** A method path the mutator may call, and the input check it must pass. */
export type MutationInputCheck = (input: unknown) => string | null

const MODEL_STUDIO_ACTIONS: ReadonlySet<string> = new Set(['ensureFormatsThenDistribute'])

function checkModelStudioAction(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return 'addons.custom input must be an object'
  const addonId: unknown = Reflect.get(input, 'addonId')
  const action: unknown = Reflect.get(input, 'action')
  if (addonId !== 'model-studio') return 'addons.custom is allowed for addonId "model-studio" only'
  if (typeof action !== 'string' || !MODEL_STUDIO_ACTIONS.has(action)) {
    return `model-studio action "${String(action)}" is not allow-listed (allowed: ${[...MODEL_STUDIO_ACTIONS].join(', ')})`
  }
  return null
}

export const MUTATION_ALLOWLIST: ReadonlyMap<string, MutationInputCheck> = new Map([
  ['pipelineOrchestrator.startNodeBenchmark', () => null],
  ['addons.custom', checkModelStudioAction],
])

export interface GatedMutatorDeps {
  readonly server: string
  readonly tier: CredentialTier
  readonly index: ApiIndex
  readonly client: HubClient
}

export function createGatedMutator(deps: GatedMutatorDeps): OpsMutator {
  return {
    server: deps.server,
    tier: deps.tier,
    async mutate(methodPath, input) {
      const check = MUTATION_ALLOWLIST.get(methodPath)
      if (!check) {
        throw new QueryRefusedError(
          `${methodPath} is not an allow-listed mutation (allowed: ${[...MUTATION_ALLOWLIST.keys()].join(', ')})`,
        )
      }
      const method = deps.index.get(methodPath)
      if (!method || method.kind !== 'mutation') {
        throw new QueryRefusedError(`${methodPath} is not a mutation in the generated API index`)
      }
      if (method.auth === 'admin' && deps.tier !== 'admin') {
        throw new QueryRefusedError(
          `${methodPath} is admin-tier and this credential is not admin-scoped`,
        )
      }
      const problem = check(input)
      if (problem !== null) throw new QueryRefusedError(problem)
      return deps.client.call('POST', methodPath, input)
    },
  }
}

export interface GatedHubDeps {
  readonly server: string
  readonly tier: CredentialTier
  readonly source: CredentialSource
  readonly index: ApiIndex
  readonly client: HubClient
  readonly downloader?: HubDownloader
  /** See {@link OpsHub.adminHint}; defaults to none. */
  readonly adminHint?: string | null
  /** The login command (for the 401/403 message). */
  readonly loginCommand?: string
}

/** A 401/403 on an admin credential: say what to run, keep the hub's own words. */
function withRejectedAdminHint(
  err: unknown,
  tier: CredentialTier,
  command: string | undefined,
): unknown {
  if (tier !== 'admin') return err
  const status = err instanceof HubHttpError || err instanceof HubRpcError ? err.status : 0
  if (status !== 401 && status !== 403) return err
  const message = err instanceof Error ? err.message : String(err)
  return new Error(`${message}\n${adminRejectedHint(command)}`, { cause: err })
}

/** Pure assembly of the gate and a client — what the unit tests drive. */
export function createGatedHub(deps: GatedHubDeps): OpsHub {
  return {
    server: deps.server,
    tier: deps.tier,
    source: deps.source,
    adminHint: deps.adminHint ?? null,
    async query(methodPath, input) {
      const decision = gateQuery(deps.index, methodPath, deps.tier)
      if (!decision.allowed) {
        const hint =
          deps.adminHint && decision.reason.includes('admin-tier') ? ` ${deps.adminHint}` : ''
        throw new QueryRefusedError(`${decision.reason}${hint}`)
      }
      try {
        return await deps.client.call('GET', methodPath, input)
      } catch (err) {
        throw withRejectedAdminHint(err, deps.tier, deps.loginCommand)
      }
    },
    async download(urlPath, destFile, maxBytes) {
      if (!isRetrainExportPath(urlPath)) {
        throw new QueryRefusedError(
          `${urlPath} is not an allow-listed data-plane download (only /addon/<id>/retrain-export)`,
        )
      }
      if (deps.tier !== 'admin') {
        throw new QueryRefusedError(
          'the retrain export is admin-only; this credential is not admin-scoped',
        )
      }
      if (!deps.downloader) throw new Error('no downloader configured for this hub')
      return deps.downloader(urlPath, destFile, maxBytes)
    },
  }
}

const RETRAIN_EXPORT_PATH = /^\/addon\/[A-Za-z0-9._-]+\/retrain-export(?:\?[^#\s]*)?$/

export function isRetrainExportPath(urlPath: string): boolean {
  return RETRAIN_EXPORT_PATH.test(urlPath)
}

export interface ConnectOptions extends HubConnectOptions {
  readonly index: ApiIndex
}

async function connect(options: ConnectOptions): Promise<HubConnection> {
  return connectHub(options)
}

export async function connectOpsHub(options: ConnectOptions): Promise<OpsHub> {
  const c = await connect(options)
  return createGatedHub({
    server: c.server,
    tier: c.tier,
    source: c.source,
    index: options.index,
    client: c.client,
    adminHint: c.adminHint,
    loginCommand: c.loginCommand,
    downloader: createHubDownloader({ baseUrl: c.server, token: c.token, tls: c.tls }),
  })
}

/** Only called when the server runs with `--allow-mutations`. */
export async function connectOpsMutator(options: ConnectOptions): Promise<OpsMutator> {
  const c = await connect(options)
  return createGatedMutator({
    server: c.server,
    tier: c.tier,
    index: options.index,
    client: c.client,
  })
}
