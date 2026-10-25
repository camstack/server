/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- mirror of the eslint debt in @camstack/addon-auth-oidc; tracked separately. */
/**
 * WebAuthn / Passkey authentication addon.
 *
 * Implements the standard two-leg ceremonies for both enrollment
 * (registration) and authentication, backed by `@simplewebauthn/server`.
 *
 * Enrollment (admin or self):
 *   1. `beginRegistration` → server returns
 *      PublicKeyCredentialCreationOptions w/ a random challenge.
 *      Stored in-memory keyed by `(userId, challenge)` w/ 5min TTL.
 *   2. Browser calls `navigator.credentials.create(options)`.
 *   3. `finishRegistration` → server verifies the attestation against
 *      the stored challenge, persists the credential (publicKey +
 *      counter + transports + operator-chosen label).
 *
 * Authentication (during 2FA login leg):
 *   1. `beginAuthentication` → server returns
 *      PublicKeyCredentialRequestOptions, listing the user's enrolled
 *      credentials in `allowCredentials`.
 *   2. Browser calls `navigator.credentials.get(options)`.
 *   3. `finishAuthentication` → server verifies the assertion against
 *      the stored publicKey + counter, bumps the counter.
 *
 * Relying-Party id (RP ID) MUST match the hub's domain (or a parent
 * of it). Defaults to the hostname of the hub's browser-facing address
 * from the Network page (`hubBrowserOrigin`); operator overrides via settings.
 *
 * Open follow-ups:
 *   - Login flow integration (today this addon only provides the
 *     cap; the auth router doesn't yet gate sessions on passkey
 *     verification — that's a separate piece tied to the TOTP gate).
 *   - Multi-device discovery (passkey-discovery flow w/ resident keys).
 */

import {
  addonWidgetsSourceCapability,
  BaseAddon,
  type ConfigInfoField,
  type ConfigUISchemaWithValues,
  type IAddonWidgetsSourceProvider,
  type ILoginMethodProvider,
  type IUserPasskeysProvider,
  loginMethodCapability,
  type PasskeySummary,
  type ProviderRegistration,
  userPasskeysCapability,
} from '@camstack/types'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/types'
import { z } from 'zod'
import { hubBrowserOrigin } from '../hub-browser-origin.js'
import { authWebauthnRecordKinds } from './record-kinds.js'
import { PasskeyStore, type StoredPasskey } from './passkey-store.js'
import { authWebauthnWidgets, buildAuthWebauthnLoginMethods } from './widget-catalog.js'

/** Minimal shape of a `network-access` endpoint entry we consume. */
const EndpointSchema = z.object({ hostname: z.string(), url: z.string() })
const EndpointsSchema = z.array(EndpointSchema)

interface WebauthnConfig {
  /** Relying Party id — must match the hub's domain. Empty = derive from the hub address on the Network page. */
  readonly rpID: string
  /** Operator-visible product name embedded in the passkey (shows up in the OS authenticator UI). */
  readonly rpName: string
  /** Allowed origins for assertions. Empty = the hub address on the Network page. */
  readonly origin: string
  /** Challenge TTL in seconds. Default 300 (5 min). */
  readonly challengeTtlSec: number
}

const DEFAULT_CONFIG: WebauthnConfig = {
  rpID: '',
  rpName: 'CamStack',
  origin: '',
  challengeTtlSec: 300,
}

/** Bound on in-flight ceremonies: the begin legs are public, so a flood must not grow the map. */
export const MAX_PENDING_CHALLENGES = 1_000

interface PendingChallenge {
  readonly challenge: string
  readonly userId: string
  /**
   * Which ceremony minted the challenge. A challenge is spendable ONLY
   * on the finish leg of the SAME kind — a second-factor
   * (`authentication`) challenge can never be replayed against the
   * usernameless (`discoverable-authentication`) finish leg and vice
   * versa.
   */
  readonly kind: 'registration' | 'authentication' | 'discoverable-authentication'
  readonly createdAt: number
}

/** Outcome of the usernameless finish leg — `userId` set iff verified. */
interface DiscoverableAuthResult {
  readonly verified: boolean
  readonly userId: string | null
}

export class AuthWebauthnAddon extends BaseAddon<WebauthnConfig> {
  private store: PasskeyStore | null = null
  private readonly pending = new Map<string, PendingChallenge>()

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const records = this.ctx.records
    if (!records) {
      throw new Error('addon-auth-webauthn: ctx.records required')
    }
    await records.declare(authWebauthnRecordKinds)
    this.store = new PasskeyStore({
      passkeysKind: records.kind(authWebauthnRecordKinds.passkeys),
      prefsKind: records.kind(authWebauthnRecordKinds['passkey-prefs']),
    })

    const provider: IUserPasskeysProvider = {
      beginRegistration: async ({ userId, username }) => this.beginRegistration(userId, username),
      finishRegistration: async ({ userId, response, label }) =>
        this.finishRegistration(userId, response, label),
      beginAuthentication: async ({ userId }) => this.beginAuthentication(userId),
      finishAuthentication: async ({ userId, response }) =>
        this.finishAuthentication(userId, response),
      beginDiscoverableAuthentication: async () => this.beginDiscoverableAuthentication(),
      finishDiscoverableAuthentication: async ({ response }) =>
        this.finishDiscoverableAuthentication(response),
      listPasskeys: async ({ userId }) => this.listPasskeys(userId),
      removePasskey: async ({ userId, credentialId }) => this.removePasskey(userId, credentialId),
      getSecondFactorPreference: async ({ userId }) => this.getSecondFactorPreference(userId),
      setSecondFactorPreference: async ({ userId, enabled }) =>
        this.setSecondFactorPreference(userId, enabled),
    }

    // Widget bundle contribution — the addon owns the whole WebAuthn
    // browser ceremony, so its enrollment + login widgets ship from here
    // (`dist/webauthn/remoteEntry.js`). `addon-widgets-source` surfaces
    // the post-auth enrollment widget through the normal registry; the
    // pre-auth `passkey-login` widget is discovered via `login-method`.
    const widgetsProvider: IAddonWidgetsSourceProvider = {
      listWidgets: async () => authWebauthnWidgets,
    }
    const loginMethodProvider: ILoginMethodProvider = {
      getLoginMethods: async () =>
        buildAuthWebauthnLoginMethods(await this.resolveRpID(), await this.resolveOrigin()),
    }

    this.ctx.logger.info('WebAuthn passkey provider initialized', {
      // The derived RP ID is resolved per ceremony (the Network page can
      // change it), so only an operator-pinned one is a boot-time fact.
      meta: {
        rpID: this.config.rpID?.trim() || '(derived from Network)',
        rpName: this.config.rpName,
      },
    })

    return [
      { capability: userPasskeysCapability, provider: provider as never },
      { capability: addonWidgetsSourceCapability, provider: widgetsProvider },
      { capability: loginMethodCapability, provider: loginMethodProvider },
    ]
  }

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'webauthn',
          title: 'WebAuthn / Passkey Settings',
          description:
            "Configure the relying-party (RP) identity baked into every enrolled passkey. RP ID MUST match the hub's public domain (or a parent of it) — changing it invalidates existing passkeys.",
          columns: 1,
          fields: [
            this.field({
              type: 'text',
              key: 'rpName',
              label: 'Product name',
              description: 'Shown in the OS authenticator UI (e.g. "CamStack"). Cosmetic only.',
              default: DEFAULT_CONFIG.rpName,
            }),
            this.field({
              type: 'text',
              key: 'rpID',
              label: 'RP ID',
              description:
                'Hub domain (NO scheme, NO port). Empty = derive from the hub address in Network (public tunnel, then mesh, then LAN). Pin it: changing RP ID invalidates enrolled passkeys. localhost works for dev.',
              default: '',
            }),
            this.field({
              type: 'text',
              key: 'origin',
              label: 'Origin',
              description:
                'Full origin scheme+host+port allowed for assertions. Empty = the hub address in Network.',
              default: '',
            }),
            this.field({
              type: 'number',
              key: 'challengeTtlSec',
              label: 'Challenge TTL (seconds)',
              description: 'How long an in-flight challenge stays valid. Default 300.',
              default: DEFAULT_CONFIG.challengeTtlSec,
            }),
          ],
        },
      ],
    })
  }

  /**
   * Surface the cluster's registered public endpoints as an RP ID /
   * origin suggestion. Fed by the `network-access` CAPABILITY (via
   * `ctx.api`) — cap-driven, never a hardcoded hostname or a specific
   * ingress addon. Injected as a read-only info banner atop the settings
   * form so the operator can pick the canonical login hostname. Degrades
   * to the bare schema when no ingress provider is installed.
   */
  override async getGlobalSettings(
    overlay?: Record<string, unknown>,
    cap?: string,
    nodeId?: string,
  ): Promise<ConfigUISchemaWithValues | null> {
    const base = await super.getGlobalSettings(overlay, cap, nodeId)
    if (!base) return base
    const hint = await this.buildEndpointHintField()
    if (!hint) return base
    return {
      ...base,
      sections: base.sections.map((s) =>
        s.id === 'webauthn' ? { ...s, fields: [hint, ...s.fields] } : s,
      ),
    }
  }

  private async buildEndpointHintField(): Promise<ConfigInfoField | null> {
    try {
      const api = this.ctx.api
      if (!api) return null
      const raw = await api.networkAccess.listEndpoints.query()
      const parsed = EndpointsSchema.safeParse(raw)
      if (!parsed.success || parsed.data.length === 0) return null
      const hosts = [...new Set(parsed.data.map((e) => e.hostname))].filter((h) => h.length > 0)
      const origins = [...new Set(parsed.data.map((e) => e.url.replace(/\/+$/, '')))].filter(
        (u) => u.length > 0,
      )
      if (hosts.length === 0) return null
      const content =
        `Detected public endpoints (from the network-access capability). ` +
        `Set RP ID to one canonical hostname — ${hosts.join(', ')} — and Origin to its full ` +
        `origin${origins.length > 0 ? ` (e.g. ${origins[0]})` : ''}. ` +
        `Changing RP ID invalidates every already-enrolled passkey.`
      return {
        type: 'info',
        key: 'detectedEndpoints',
        label: 'Suggested RP ID / origin',
        content,
        variant: 'info',
      }
    } catch {
      return null
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * The hub's browser-facing address when the operator pinned neither RP ID
   * nor origin: the Network page's (`hubBrowserOrigin`), else the development
   * default. An RP ID derived from it changes when the hub's address does —
   * which is why the settings banner asks the operator to PIN one.
   */
  private async derivedOrigin(): Promise<string> {
    return (
      (await hubBrowserOrigin(this.ctx.api.localNetwork, this.ctx.logger)) ??
      'http://localhost:4443'
    )
  }

  private async resolveRpID(): Promise<string> {
    if (this.config.rpID && this.config.rpID.trim()) return this.config.rpID.trim()
    try {
      return new URL(await this.derivedOrigin()).hostname
    } catch {
      return 'localhost'
    }
  }

  private async resolveOrigin(): Promise<string> {
    if (this.config.origin && this.config.origin.trim())
      return this.config.origin.trim().replace(/\/+$/, '')
    return this.derivedOrigin()
  }

  private challengeTtlMs(): number {
    return (this.config.challengeTtlSec || DEFAULT_CONFIG.challengeTtlSec) * 1000
  }

  /**
   * Room for one more ceremony: expired challenges go first, and when the map
   * is still full the new ceremony is REFUSED - a live challenge is never
   * evicted to make room (D858). The begin legs are public.
   */
  private admitChallenge(): void {
    this.pruneExpiredChallenges()
    if (this.pending.size >= MAX_PENDING_CHALLENGES) {
      throw new Error('Too many pending passkey ceremonies - try again shortly')
    }
  }

  private pruneExpiredChallenges(): void {
    const now = Date.now()
    const ttlMs = this.challengeTtlMs()
    for (const [k, v] of this.pending.entries()) {
      if (now - v.createdAt > ttlMs) this.pending.delete(k)
    }
  }

  private base64urlEncode(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url')
  }

  private base64urlDecode(s: string): Uint8Array {
    return new Uint8Array(Buffer.from(s, 'base64url'))
  }

  /** Cap wire shape — {@link IUserPasskeysProvider} carries opaque JSON records. */
  private wirePasskeyOptions(
    options: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON,
  ): Record<string, unknown> {
    return Object.fromEntries(Object.entries(options))
  }

  // ── Cap methods ──────────────────────────────────────────────────

  private async beginRegistration(
    userId: string,
    username: string,
  ): Promise<{ optionsJSON: Record<string, unknown> }> {
    if (!this.store) throw new Error('passkey store unavailable')
    this.admitChallenge()
    const existing = await this.store.findByUserId(userId)
    const options = await generateRegistrationOptions({
      rpID: await this.resolveRpID(),
      rpName: this.config.rpName || DEFAULT_CONFIG.rpName,
      userID: new TextEncoder().encode(userId),
      userName: username,
      userDisplayName: username,
      attestationType: 'none',
      // Avoid enrolling the same authenticator twice — clients show
      // a friendly "you already have a passkey on this device".
      excludeCredentials: existing.map((p) => ({
        id: p.credentialId,
        transports: p.transports as never,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    })
    this.pending.set(options.challenge, {
      challenge: options.challenge,
      userId,
      kind: 'registration',
      createdAt: Date.now(),
    })
    return { optionsJSON: this.wirePasskeyOptions(options) }
  }

  private async finishRegistration(
    userId: string,
    response: Record<string, unknown>,
    label: string,
  ): Promise<{ success: true; credentialId: string }> {
    if (!this.store) throw new Error('passkey store unavailable')
    // The browser response carries the challenge inside `clientDataJSON`
    // (base64url JSON). We look it up in our pending map to find the
    // matching userId + verify the kind.
    const clientData = this.decodeClientData(response)
    const challenge = clientData?.challenge
    if (!challenge) throw new Error('finishRegistration: response missing challenge')
    const pending = this.pending.get(challenge)
    if (!pending || pending.userId !== userId || pending.kind !== 'registration') {
      throw new Error('finishRegistration: unknown or expired challenge')
    }
    this.pending.delete(challenge)

    const verification = await verifyRegistrationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedRPID: await this.resolveRpID(),
      expectedOrigin: await this.resolveOrigin(),
    })

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('finishRegistration: attestation verification failed')
    }

    const info = verification.registrationInfo
    const credential = info.credential
    const credentialId = credential.id // already base64url
    const publicKeyB64 = this.base64urlEncode(credential.publicKey)
    const stored: StoredPasskey = {
      credentialId,
      userId,
      publicKey: publicKeyB64,
      counter: credential.counter,
      transports: credential.transports ?? [],
      label: label.trim() || 'Unnamed device',
      createdAt: Date.now(),
      lastUsedAt: null,
    }
    await this.store.insert(stored)
    return { success: true as const, credentialId }
  }

  private async beginAuthentication(
    userId: string | undefined,
  ): Promise<{ optionsJSON: Record<string, unknown> }> {
    if (!this.store) throw new Error('passkey store unavailable')
    this.admitChallenge()
    const userPasskeys = userId ? await this.store.findByUserId(userId) : []
    const options = await generateAuthenticationOptions({
      rpID: await this.resolveRpID(),
      // Empty list = "discoverable credential" flow — the browser
      // shows ALL passkeys it has for this RP. Useful for sign-in
      // without typing a username first.
      allowCredentials: userPasskeys.map((p) => ({
        id: p.credentialId,
        transports: p.transports as never,
      })),
      userVerification: 'preferred',
    })
    this.pending.set(options.challenge, {
      challenge: options.challenge,
      userId: userId ?? '',
      kind: 'authentication',
      createdAt: Date.now(),
    })
    return { optionsJSON: this.wirePasskeyOptions(options) }
  }

  private async finishAuthentication(
    userId: string,
    response: Record<string, unknown>,
  ): Promise<{ verified: boolean }> {
    if (!this.store) return { verified: false }
    const clientData = this.decodeClientData(response)
    const challenge = clientData?.challenge
    if (!challenge) return { verified: false }
    const pending = this.pending.get(challenge)
    if (!pending || pending.kind !== 'authentication') return { verified: false }
    // Discovery flow: pending.userId is empty; the credentialId resolves the user.
    // Strict-user flow: pending.userId must match the caller's userId.
    if (pending.userId && pending.userId !== userId) return { verified: false }
    this.pending.delete(challenge)

    const credentialId = typeof response['id'] === 'string' ? response['id'] : ''
    const stored = await this.store.findByCredentialId(credentialId)
    if (!stored) return { verified: false }
    if (stored.userId !== userId) return { verified: false }

    let verification: { verified: boolean; authenticationInfo?: { newCounter: number } }
    try {
      verification = await verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge: challenge,
        expectedRPID: await this.resolveRpID(),
        expectedOrigin: await this.resolveOrigin(),
        credential: {
          id: stored.credentialId,
          publicKey: this.base64urlDecode(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports as never,
        },
      })
    } catch (err) {
      this.ctx.logger.warn('Passkey verification threw', {
        meta: { credentialId, err: err instanceof Error ? err.message : String(err) },
      })
      return { verified: false }
    }

    if (!verification.verified || !verification.authenticationInfo) {
      return { verified: false }
    }
    await this.store.updateCounter(credentialId, verification.authenticationInfo.newCounter)
    this.ctx.logger.info('passkey login verified', {
      meta: { userId, credentialId, transports: stored.transports },
    })
    return { verified: true }
  }

  /**
   * Usernameless (discoverable-credential) login — leg 1. Issues
   * assertion options with an EMPTY `allowCredentials` list so the
   * browser offers every resident passkey it holds for this RP, and
   * `userVerification: 'required'` because the passkey is the ONLY
   * factor (it replaces both username/password and the 2FA leg).
   * The challenge is stored server-side keyed by its own value and is
   * NOT bound to any user — `finishDiscoverableAuthentication` resolves
   * the owner from the asserted credential id.
   */
  private async beginDiscoverableAuthentication(): Promise<{
    optionsJSON: Record<string, unknown>
  }> {
    if (!this.store) throw new Error('passkey store unavailable')
    this.admitChallenge()
    const options = await generateAuthenticationOptions({
      rpID: await this.resolveRpID(),
      allowCredentials: [],
      userVerification: 'required',
    })
    this.pending.set(options.challenge, {
      challenge: options.challenge,
      userId: '',
      kind: 'discoverable-authentication',
      createdAt: Date.now(),
    })
    return { optionsJSON: this.wirePasskeyOptions(options) }
  }

  /**
   * Usernameless login — leg 2. Resolves the credential by the
   * response's credential id, verifies the assertion against the stored
   * challenge + that credential's public key/counter, and returns the
   * OWNING userId. Fail-closed: every anomaly returns
   * `{ verified: false, userId: null }`.
   *
   * Replay protection: the pending challenge is consumed (deleted)
   * BEFORE verification, so an assertion can be spent exactly once.
   * The TTL is enforced here too — pruning alone only runs on begin
   * legs, which an attacker controls the timing of.
   */
  private async finishDiscoverableAuthentication(
    response: Record<string, unknown>,
  ): Promise<DiscoverableAuthResult> {
    if (!this.store) return { verified: false, userId: null }
    const clientData = this.decodeClientData(response)
    const challenge = clientData?.challenge
    if (!challenge) return { verified: false, userId: null }
    const pending = this.pending.get(challenge)
    // Kind isolation: a strict-user second-factor challenge must never
    // be spendable on the usernameless leg (and vice versa).
    if (!pending || pending.kind !== 'discoverable-authentication') {
      return { verified: false, userId: null }
    }
    this.pending.delete(challenge)
    if (Date.now() - pending.createdAt > this.challengeTtlMs()) {
      return { verified: false, userId: null }
    }

    const credentialId = typeof response['id'] === 'string' ? response['id'] : ''
    const stored = await this.store.findByCredentialId(credentialId)
    if (!stored) return { verified: false, userId: null }

    let verification: { verified: boolean; authenticationInfo?: { newCounter: number } }
    try {
      verification = await verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge: challenge,
        expectedRPID: await this.resolveRpID(),
        expectedOrigin: await this.resolveOrigin(),
        // The passkey is the sole factor — a non-UV assertion (counter
        // regression aside) must not mint a session.
        requireUserVerification: true,
        credential: {
          id: stored.credentialId,
          publicKey: this.base64urlDecode(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports as never,
        },
      })
    } catch (err) {
      // Includes @simplewebauthn's counter-regression rejection
      // (cloned-authenticator detection) and signature failures.
      this.ctx.logger.warn('Discoverable passkey verification threw', {
        meta: { credentialId, err: err instanceof Error ? err.message : String(err) },
      })
      return { verified: false, userId: null }
    }

    if (!verification.verified || !verification.authenticationInfo) {
      return { verified: false, userId: null }
    }
    await this.store.updateCounter(credentialId, verification.authenticationInfo.newCounter)
    this.ctx.logger.info('passkey login verified', {
      meta: { userId: stored.userId, credentialId, transports: stored.transports },
    })
    return { verified: true, userId: stored.userId }
  }

  private async listPasskeys(userId: string): Promise<PasskeySummary[]> {
    if (!this.store) return []
    const rows = await this.store.findByUserId(userId)
    return rows.map((r) => ({
      credentialId: r.credentialId,
      label: r.label,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      transports: [...r.transports],
    }))
  }

  /**
   * Second-factor preference (opt-in, default OFF). Enrolling a passkey
   * only enables passkey-first sign-in; the password login flow demands
   * the passkey second leg ONLY when this flag is explicitly enabled.
   */
  private async getSecondFactorPreference(userId: string): Promise<{ enabled: boolean }> {
    if (!this.store) return { enabled: false }
    return { enabled: await this.store.getSecondFactorPreference(userId) }
  }

  private async setSecondFactorPreference(
    userId: string,
    enabled: boolean,
  ): Promise<{ success: true }> {
    if (!this.store) throw new Error('passkey store unavailable')
    await this.store.setSecondFactorPreference(userId, enabled)
    return { success: true as const }
  }

  private async removePasskey(userId: string, credentialId: string): Promise<{ success: true }> {
    if (!this.store) throw new Error('passkey store unavailable')
    const existing = await this.store.findByCredentialId(credentialId)
    if (!existing) throw new Error(`Passkey not found: ${credentialId}`)
    if (existing.userId !== userId) throw new Error('Passkey does not belong to user')
    await this.store.delete(credentialId)
    return { success: true as const }
  }

  // ── Utilities ────────────────────────────────────────────────────

  /** Decode the `clientDataJSON` field of a WebAuthn response. */
  private decodeClientData(
    response: Record<string, unknown>,
  ): { challenge?: string; type?: string; origin?: string } | null {
    const responseField = response['response']
    if (!responseField || typeof responseField !== 'object') return null
    const clientDataJSON = (responseField as Record<string, unknown>)['clientDataJSON']
    if (typeof clientDataJSON !== 'string') return null
    try {
      const raw = Buffer.from(clientDataJSON, 'base64url').toString('utf-8')
      return JSON.parse(raw) as { challenge?: string; type?: string; origin?: string }
    } catch {
      return null
    }
  }
}

export default AuthWebauthnAddon
