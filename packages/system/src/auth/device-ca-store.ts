/**
 * Loads the device CA from the keychain + settings, and creates it LAZILY on
 * the first enrollment (D855). Never rotated on boot, never silently replaced.
 *
 * The two halves of the CA and what each combination means:
 *
 *   key  cert   state
 *   ---- ----   -----------------------------------------------------------
 *   no   no     `absent`       - no device was ever enrolled: `ensure()` creates it
 *   yes  yes    `ready`
 *   yes  no     recovered      - a creation that died between its two writes:
 *                                the certificate is rebuilt from the SAME key
 *                                (same subject, same public key, so every leaf
 *                                already issued still verifies) and written
 *   no   yes    `unavailable`  - the key is GONE (keychain reset, restore). A
 *                                new CA would orphan every enrolled device
 *                                without a word, so this is an explicit error:
 *                                logged, shown by `getDeviceCaStatus`, and
 *                                `ensure()` refuses. The operator restores the
 *                                key (or knowingly removes `cluster.deviceCa`).
 *
 * Creation order is KEY first, then certificate. If the certificate write
 * fails after the key was stored, the next `lookup()` finds (yes, no) and
 * completes the creation deterministically - there is no half-state that needs
 * a human.
 */
import type { IScopedLogger, SecretsAccess } from '@camstack/types'
import {
  DEVICE_CA_FIELD,
  DEVICE_CA_KEY_REF,
  DEVICE_CA_SETTINGS_SECTION,
  type DeviceCaSigner,
  generateDeviceCa,
  loadDeviceCa,
  rebuildDeviceCaCertificate,
} from './device-ca.js'

export interface DeviceCaStoreDeps {
  /** Keychain handle for owner `system`; `null` when this process has no keychain door. */
  readonly secrets: SecretsAccess | null
  readonly readSection: (section: string) => Promise<Record<string, unknown>>
  readonly writeSection: (section: string, patch: Record<string, unknown>) => Promise<void>
  readonly logger?: IScopedLogger
}

export type DeviceCaLookup =
  | { readonly state: 'ready'; readonly ca: DeviceCaSigner }
  | { readonly state: 'absent' }
  | { readonly state: 'unavailable'; readonly reason: string }

function hasCertificate(value: unknown): value is string {
  return typeof value === 'string' && value.includes('BEGIN CERTIFICATE')
}

export class DeviceCaStore {
  private loaded: DeviceCaSigner | null = null
  private creating: Promise<DeviceCaSigner> | null = null
  private lastReported: string | null = null

  constructor(private readonly deps: DeviceCaStoreDeps) {}

  /** The CA when one exists (completing an interrupted creation). Never creates a NEW one. */
  async lookup(): Promise<DeviceCaLookup> {
    if (this.loaded !== null) return { state: 'ready', ca: this.loaded }
    const secrets = this.deps.secrets
    if (secrets === null) {
      return { state: 'unavailable', reason: 'no keychain door in this process' }
    }
    let entry: Awaited<ReturnType<SecretsAccess['resolve']>>[string] | undefined
    try {
      entry = (await secrets.resolve([DEVICE_CA_KEY_REF]))[DEVICE_CA_KEY_REF]
    } catch (err: unknown) {
      return { state: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
    }
    if (entry === undefined) return { state: 'unavailable', reason: 'no-answer' }
    if (entry.kind === 'unavailable') return { state: 'unavailable', reason: entry.reason }
    if (entry.kind === 'forbidden') return { state: 'unavailable', reason: 'forbidden' }

    let section: Record<string, unknown>
    try {
      section = await this.deps.readSection(DEVICE_CA_SETTINGS_SECTION)
    } catch (err: unknown) {
      return {
        state: 'unavailable',
        reason: `settings unreadable: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    const certPem: unknown = section[DEVICE_CA_FIELD]

    if (entry.kind === 'missing') {
      if (!hasCertificate(certPem)) return { state: 'absent' }
      return this.report(
        'the device CA key is missing from the keychain but cluster.deviceCa is present - ' +
          'not creating a new CA (it would orphan every enrolled device); restore the key ' +
          '(secret://system/global/deviceCaKey) or remove cluster.deviceCa knowingly',
      )
    }

    try {
      if (!hasCertificate(certPem)) {
        // Interrupted creation: rebuild the certificate from the stored key.
        const rebuilt = await rebuildDeviceCaCertificate(entry.value)
        await this.deps.writeSection(DEVICE_CA_SETTINGS_SECTION, {
          [DEVICE_CA_FIELD]: rebuilt.certPem,
        })
        this.deps.logger?.warn('Device CA certificate rebuilt from the stored key', {
          meta: { reason: 'cluster.deviceCa was missing next to the key' },
        })
        this.loaded = rebuilt
        return { state: 'ready', ca: rebuilt }
      }
      this.loaded = await loadDeviceCa(certPem, entry.value)
      return { state: 'ready', ca: this.loaded }
    } catch (err: unknown) {
      return { state: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
    }
  }

  /** The CA, created now if neither half exists. Throws on any inconsistent or unreadable state. */
  async ensure(): Promise<DeviceCaSigner> {
    const found = await this.lookup()
    if (found.state === 'ready') return found.ca
    if (found.state === 'unavailable') throw new Error(`device CA unavailable: ${found.reason}`)
    if (this.creating === null) {
      this.creating = this.create().finally(() => {
        this.creating = null
      })
    }
    return this.creating
  }

  private report(reason: string): DeviceCaLookup {
    if (this.lastReported !== reason) {
      this.lastReported = reason
      this.deps.logger?.error(`Device CA is inconsistent: ${reason}`)
    }
    return { state: 'unavailable', reason }
  }

  private async create(): Promise<DeviceCaSigner> {
    const secrets = this.deps.secrets
    if (secrets === null) throw new Error('device CA unavailable: no keychain door')
    const generated = await generateDeviceCa()
    // Key first: if the certificate write below fails, `lookup()` completes it.
    await secrets.put(DEVICE_CA_KEY_REF, generated.keyPem)
    await this.deps.writeSection(DEVICE_CA_SETTINGS_SECTION, {
      [DEVICE_CA_FIELD]: generated.certPem,
    })
    this.loaded = await loadDeviceCa(generated.certPem, generated.keyPem)
    return this.loaded
  }
}
