import { X509Certificate } from 'node:crypto'
import type { Server as TlsServer } from 'node:tls'
import type { TlsCertPair } from './cert-manager.js'

/**
 * The hub's HTTPS listener, as far as the certificate actions are concerned:
 * a way to swap the certificate it serves, and the leaf it serves right now.
 *
 * The listener is created by the server process (`main.ts`) and the actions
 * run in the `local-network` builtin. Those two can hold DIFFERENT module
 * instances of this file — the server loads the CommonJS build, a builtin
 * entry may load its own chunk — so the slot lives on `globalThis` under a
 * registered symbol rather than in a module-level variable that one side
 * would never see.
 */
interface HttpsListenerSlot {
  readonly reload: ((pair: TlsCertPair) => void) | null
  readonly servedLeafFingerprint: string | null
}

export type HttpsReloadOutcome =
  | { readonly kind: 'reloaded'; readonly servedLeafFingerprint: string }
  | { readonly kind: 'no-listener' }
  | { readonly kind: 'failed'; readonly error: string }

const SLOT_KEY = Symbol.for('camstack.tls.https-listener')
const EMPTY_SLOT: HttpsListenerSlot = { reload: null, servedLeafFingerprint: null }

function isSlot(value: unknown): value is HttpsListenerSlot {
  if (typeof value !== 'object' || value === null) return false
  if (!('reload' in value) || !('servedLeafFingerprint' in value)) return false
  const reload: unknown = value.reload
  const served: unknown = value.servedLeafFingerprint
  return (
    (reload === null || typeof reload === 'function') &&
    (served === null || typeof served === 'string')
  )
}

function readSlot(): HttpsListenerSlot {
  const current: unknown = Reflect.get(globalThis, SLOT_KEY)
  return isSlot(current) ? current : EMPTY_SLOT
}

function writeSlot(next: HttpsListenerSlot): void {
  Reflect.set(globalThis, SLOT_KEY, next)
}

/** SHA-256 fingerprint of the first certificate (the leaf) in a PEM chain. */
export function leafFingerprintOf(chain: Buffer | string): string {
  return new X509Certificate(chain).fingerprint256
}

/**
 * Called once by the server after its HTTPS listener is up, with the pair it
 * was started on. From here on a certificate action swaps the served
 * certificate in place (`setSecureContext`) — new handshakes get the new
 * leaf, open connections keep theirs, nothing restarts.
 */
export function registerHttpsListener(server: TlsServer, pair: TlsCertPair): void {
  writeSlot({
    reload: (next) => server.setSecureContext({ cert: next.cert, key: next.key }),
    servedLeafFingerprint: leafFingerprintOf(pair.cert),
  })
}

/** Forget the listener — on shutdown, and between specs. */
export function clearHttpsListener(): void {
  writeSlot(EMPTY_SLOT)
}

/**
 * The leaf the HTTPS listener serves now, or `null` when this process has no
 * registered listener (TLS off, or a process that does not own one) — in
 * which case nobody can say, and `null` is the honest answer.
 */
export function servedHttpsLeafFingerprint(): string | null {
  return readSlot().servedLeafFingerprint
}

/** Serve `pair` from now on. Never throws: the outcome says what happened. */
export function reloadHttpsListener(pair: TlsCertPair): HttpsReloadOutcome {
  const slot = readSlot()
  if (slot.reload === null) return { kind: 'no-listener' }
  try {
    const servedLeafFingerprint = leafFingerprintOf(pair.cert)
    slot.reload(pair)
    writeSlot({ reload: slot.reload, servedLeafFingerprint })
    return { kind: 'reloaded', servedLeafFingerprint }
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}
