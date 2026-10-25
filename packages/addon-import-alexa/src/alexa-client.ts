/**
 * The Alexa cloud-client seam.
 *
 * `AlexaClient` is the clean INTERFACE the rest of the addon depends on — the
 * broker/adoption/device layers never import `alexa-remote2` directly, only this
 * interface. The real binding to `alexa-remote2` (Apollon77's unofficial
 * cookie/token Alexa client) is a TODO; for now `StubAlexaClient` provides a
 * compiling, fully-typed no-op that throws on any operation requiring the live
 * account.
 *
 * `alexa-remote2` ships NO TypeScript types and no `@types/*` package, so the
 * real binding must isolate the untyped `require('alexa-remote2')` behind an
 * ambient module declaration in THIS file's eventual implementation — never a
 * raw typed import that would break `tsc --noEmit`. Keeping it stubbed today
 * sidesteps that and keeps the addon strictly type-clean.
 *
 * Auth (plan §1.4): v1 uses the cookie / refresh-token flow. The recommended UX
 * is alexa-remote2's built-in proxy login (it spins a local OAuth-capture page);
 * the resulting `cookie` / `refreshToken` / `macDms` are stored on the broker
 * entry. State is POLL-ONLY (Alexa has no clean 3rd-party push) — see plan risks.
 *
 * The real binding now lives in `alexa-remote-client.ts` (`AlexaRemoteClient`),
 * which `createAlexaClient` returns. `StubAlexaClient` stays here as a typed
 * test double (the integration-manager / registry inject it via `makeClient`).
 */

import type { IScopedLogger } from '@camstack/types'
import { AlexaRemoteClient } from './alexa-remote-client.js'

/** One imported Alexa smart-home appliance (controller-agnostic shape). */
export interface AlexaAppliance {
  /** Alexa entity / appliance id (stable per account). */
  readonly applianceId: string
  /** Friendly name as reported by the account. */
  readonly name: string
  /** The Alexa capability interface names the appliance reports. */
  readonly interfaces: readonly string[]
  /** Optional Alexa group / room the appliance belongs to (→ CamStack location). */
  readonly groupName?: string
  /** Manufacturer label when reported. */
  readonly manufacturer?: string
}

/** A single polled state value for an appliance property. */
export interface AlexaStateValue {
  readonly applianceId: string
  /** The Alexa capability interface the value belongs to. */
  readonly interfaceName: string
  /** The Alexa property name (e.g. `powerState`, `brightness`). */
  readonly property: string
  /** The raw value (provider-specific). */
  readonly value: unknown
}

/** An outbound smart-home control command. */
export interface AlexaCommand {
  readonly applianceId: string
  readonly interfaceName: string
  /** The Alexa directive name (e.g. `TurnOn`, `SetBrightness`). */
  readonly action: string
  readonly args?: Record<string, unknown>
}

/** Credentials the operator supplies / the proxy-login captures. */
export interface AlexaCredentials {
  /** Amazon domain/region, e.g. `amazon.com` / `amazon.co.uk` / `amazon.de`. */
  readonly amazonDomain: string
  /** A captured cookie blob (preferred for a stable session). */
  readonly cookie?: string
  /** A refresh token (alternative to a cookie). */
  readonly refreshToken?: string
  /** Device-registration secret some flows need. */
  readonly macDms?: string
}

/** Thrown by the stub for every operation needing the live alexa-remote2 client. */
export class AlexaClientNotWiredError extends Error {
  constructor(op: string) {
    super(
      `import-alexa: alexa-remote2 client not wired (operation "${op}"). ` +
        'Replace StubAlexaClient with the alexa-remote2 binding.',
    )
    this.name = 'AlexaClientNotWiredError'
  }
}

/** Thrown when stored credentials are rejected — surfaced as broker `auth-failed`. */
export class AlexaAuthError extends Error {
  constructor(message: string) {
    super(`import-alexa: authentication failed — ${message}`)
    this.name = 'AlexaAuthError'
  }
}

/** The cloud-client surface the addon consumes. One client per Amazon account. */
export interface AlexaClient {
  /** Authenticate with the stored credentials. Throws {@link AlexaAuthError}. */
  connect(): Promise<void>
  /** Tear the client down (idempotent). */
  disconnect(): Promise<void>
  /** Whether the client is currently authenticated. */
  isConnected(): boolean
  /** Enumerate the account's smart-home appliances. */
  listAppliances(): Promise<readonly AlexaAppliance[]>
  /** Poll the current state values (batched). */
  pollStates(applianceIds: readonly string[]): Promise<readonly AlexaStateValue[]>
  /** Invoke an outbound control command. */
  sendCommand(command: AlexaCommand): Promise<void>
}

/** Options for constructing a client. */
export interface AlexaClientOptions {
  readonly credentials: AlexaCredentials
  readonly brokerId: string
  /**
   * Addon data directory for persisting the refreshed alexa-remote2 session
   * (cookieData). When absent the client runs in-memory (no cross-restart
   * cookie-refresh persistence) — used by tests and the stub.
   */
  readonly dataDir?: string
  /** Scoped logger for backoff / persistence diagnostics (optional). */
  readonly logger?: IScopedLogger
}

/**
 * Compiling, fully-typed stub. `connect`/`disconnect`/`listAppliances`/
 * `pollStates` are safe no-ops (empty inventory) so the addon boots; the
 * operations that mutate the account or need a live session throw
 * {@link AlexaClientNotWiredError} until alexa-remote2 is bound.
 */
export class StubAlexaClient implements AlexaClient {
  #connected = false
  readonly #options: AlexaClientOptions

  constructor(options: AlexaClientOptions) {
    this.#options = options
  }

  /** The broker id / credentials this client would authenticate with. */
  get options(): AlexaClientOptions {
    return this.#options
  }

  async connect(): Promise<void> {
    // No-op: a real client would init alexa-remote2 with the stored cookie /
    // refresh token and throw AlexaAuthError on rejection. TODO(binding).
    this.#connected = true
  }

  async disconnect(): Promise<void> {
    this.#connected = false
  }

  isConnected(): boolean {
    return this.#connected
  }

  async listAppliances(): Promise<readonly AlexaAppliance[]> {
    // No live account in the stub — an empty inventory is the honest answer.
    return []
  }

  async pollStates(_applianceIds: readonly string[]): Promise<readonly AlexaStateValue[]> {
    return []
  }

  async sendCommand(_command: AlexaCommand): Promise<void> {
    throw new AlexaClientNotWiredError('sendCommand')
  }
}

/**
 * Factory seam: build the live client for a broker. Returns the real
 * {@link AlexaRemoteClient} (alexa-remote2 binding). Tests / the stub path inject
 * their own factory via the registry/manager `makeClient` seam instead.
 */
export function createAlexaClient(options: AlexaClientOptions): AlexaClient {
  return new AlexaRemoteClient(options)
}
