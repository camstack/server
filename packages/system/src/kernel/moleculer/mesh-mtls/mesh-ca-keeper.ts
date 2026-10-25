/**
 * Keeps the hub mesh CA loaded (keychain + `cluster.meshCa`), like the JWT
 * signing-key keeper (D797). Generates at first boot; locked keychain → no
 * issuance (existing certs keep working until expiry).
 */
import type { SecretsAccess } from '@camstack/types'
import { MESH_CA_FIELD, MESH_CA_KEY_REF, MESH_CA_SETTINGS_KEY } from './constants.js'
import { generateMeshCa, loadMeshCa, type MeshCaSigner } from './mesh-ca.js'

export type MeshCaState =
  | { readonly state: 'ready'; readonly ca: MeshCaSigner }
  | { readonly state: 'unavailable'; readonly reason: string }

const SLOT = Symbol.for('camstack.mesh.ca')
const NOT_LOADED: MeshCaState = { state: 'unavailable', reason: 'not-loaded' }

function isState(value: unknown): value is MeshCaState {
  if (value === null || typeof value !== 'object') return false
  const state: unknown = Reflect.get(value, 'state')
  if (state === 'ready') return Reflect.get(value, 'ca') !== undefined
  return state === 'unavailable' && typeof Reflect.get(value, 'reason') === 'string'
}

export function setProcessMeshCa(state: MeshCaState): void {
  Reflect.set(globalThis, SLOT, state)
}

export function clearProcessMeshCa(): void {
  Reflect.deleteProperty(globalThis, SLOT)
}

export function getProcessMeshCaState(): MeshCaState {
  const value: unknown = Reflect.get(globalThis, SLOT)
  return isState(value) ? value : NOT_LOADED
}

export function requireProcessMeshCa(): MeshCaSigner {
  const state = getProcessMeshCaState()
  if (state.state !== 'ready') {
    throw new Error(`mesh CA unavailable: ${state.reason}`)
  }
  return state.ca
}

export const MESH_CA_RETRY_MS = 30_000

interface KeeperLogger {
  info(message: string, meta?: { meta?: Record<string, unknown> }): void
  error(message: string, meta?: { meta?: Record<string, unknown> }): void
  warn?(message: string, meta?: { meta?: Record<string, unknown> }): void
}

export interface MeshCaKeeperDeps {
  readonly secrets: SecretsAccess | null
  /** Read `cluster` section (may contain `meshCa` PEM). */
  readonly readClusterSection: () => Promise<Record<string, unknown>>
  /** Persist the CA cert PEM under `cluster.meshCa`. */
  readonly writeMeshCaCert: (certPem: string) => Promise<void>
  readonly logger: KeeperLogger
  readonly retryMs?: number
  /** Fired when the CA becomes ready (start TLS listener, etc.). */
  readonly onReady?: (ca: MeshCaSigner) => void | Promise<void>
}

export class MeshCaKeeper {
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private stopped = false

  constructor(private readonly deps: MeshCaKeeperDeps) {}

  async start(): Promise<void> {
    const secrets = this.deps.secrets
    if (secrets === null) {
      this.apply({ state: 'unavailable', reason: 'no keychain door in this process' })
      return
    }
    this.unsubscribe = secrets.onChange((ref) => {
      if (ref === MESH_CA_KEY_REF) void this.load(secrets)
    })
    await this.load(secrets)
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async load(secrets: SecretsAccess): Promise<void> {
    if (this.stopped) return
    const next = await loadOrGenerateMeshCa({
      secrets,
      readClusterSection: this.deps.readClusterSection,
      writeMeshCaCert: this.deps.writeMeshCaCert,
    })
    if (this.stopped) return
    this.apply(next)
    if (next.state === 'unavailable' && getProcessMeshCaState().state !== 'ready') {
      this.scheduleRetry(secrets)
    }
  }

  private apply(next: MeshCaState): void {
    const previous = getProcessMeshCaState()
    if (next.state === 'ready') {
      if (previous.state !== 'ready') {
        this.deps.logger.info('Mesh CA loaded from the keychain', {
          meta: { settingsKey: MESH_CA_SETTINGS_KEY },
        })
      }
      setProcessMeshCa(next)
      void Promise.resolve(this.deps.onReady?.(next.ca)).catch((err: unknown) => {
        this.deps.logger.error('Mesh CA onReady failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
      return
    }
    if (previous.state === 'ready') return
    setProcessMeshCa(next)
    this.deps.logger.error(
      'Mesh CA unavailable: enrollment and mTLS issuance are offline until the keychain unlocks.',
      { meta: { reason: next.reason, ref: MESH_CA_KEY_REF } },
    )
  }

  private scheduleRetry(secrets: SecretsAccess): void {
    if (this.stopped || this.retryTimer !== null) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.load(secrets)
    }, this.deps.retryMs ?? MESH_CA_RETRY_MS)
    this.retryTimer.unref?.()
  }
}

export interface LoadOrGenerateMeshCaDeps {
  readonly secrets: SecretsAccess
  readonly readClusterSection: () => Promise<Record<string, unknown>>
  readonly writeMeshCaCert: (certPem: string) => Promise<void>
}

export async function loadOrGenerateMeshCa(deps: LoadOrGenerateMeshCaDeps): Promise<MeshCaState> {
  let entry: Awaited<ReturnType<SecretsAccess['resolve']>>[string] | undefined
  try {
    entry = (await deps.secrets.resolve([MESH_CA_KEY_REF]))[MESH_CA_KEY_REF]
  } catch (err: unknown) {
    return { state: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
  }
  if (entry === undefined) return { state: 'unavailable', reason: 'no-answer' }

  switch (entry.kind) {
    case 'unavailable':
      return { state: 'unavailable', reason: entry.reason }
    case 'forbidden':
      return { state: 'unavailable', reason: 'forbidden' }
    case 'value': {
      const section = await deps.readClusterSection().catch(() => ({}) as Record<string, unknown>)
      const certPem = section[MESH_CA_FIELD]
      if (typeof certPem !== 'string' || !certPem.includes('BEGIN CERTIFICATE')) {
        return {
          state: 'unavailable',
          reason: 'mesh CA key is stored but cluster.meshCa cert PEM is missing',
        }
      }
      try {
        const ca = await loadMeshCa(certPem, entry.value)
        return { state: 'ready', ca }
      } catch (err: unknown) {
        return {
          state: 'unavailable',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    }
    case 'missing': {
      try {
        const generated = await generateMeshCa()
        await deps.secrets.put(MESH_CA_KEY_REF, generated.keyPem)
        await deps.writeMeshCaCert(generated.certPem)
        const ca = await loadMeshCa(generated.certPem, generated.keyPem)
        return { state: 'ready', ca }
      } catch (err: unknown) {
        return {
          state: 'unavailable',
          reason: `could not create mesh CA: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
  }
}
