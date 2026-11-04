/**
 * The settings shape of the Alexa addon and how the routes read it. Moved out of the addon file
 * so the per-skill runtime and the routes can import it without a cycle.
 */
import type { StoredVisibilityMap } from './access/account-visibility.js'
import type { StoredDetectionClassMap } from './detection-sensors/detection-classes.js'
import { PUBLIC_SKILL_ID } from './public-skill.js'
import type { LinkedAccount, LwaTokenEntry } from './types.js'

export type AlexaRegion = 'NA' | 'EU' | 'FE'

export type SkillMode = 'public' | 'custom'

export interface AlexaSettings {
  /**
   * Which Alexa skill backs this export. `public` uses the built-in CamStack
   * skill (its id is in `public-skill.ts`) so no Amazon developer setup is
   * needed. `custom` uses the operator's own skill (`expectedAudience`) and
   * the operator's own copy of the skill Lambda. Either way the hub holds NO
   * LWA client secret: the skill's Lambda brokers Event Gateway tokens (D753).
   */
  readonly skillMode: SkillMode
  /** Alexa skill id (e.g. `amzn1.ask.skill.xxxx`). Operator-pasted. Used only
   *  in `skillMode: 'custom'` (public mode reads `PUBLIC_SKILL_ID`). */
  readonly expectedAudience: string
  /** @deprecated D753 — never read. The skill Lambda holds the LWA client;
   *  kept only so an old stored value parses. */
  readonly lwaClientId: string
  /** @deprecated D753 — never read, and scrubbed to '' on boot: the hub must
   *  not hold the LWA client secret. */
  readonly lwaClientSecret: string
  /**
   * Origin of the skill Lambda's token broker, as advertised on the last
   * verified directive (`x-camstack-broker`). Hidden state. Used only to
   * migrate a pre-D753 push grant; a broker grant carries its own URL.
   */
  readonly advertisedBrokerUrl: string
  /** Region the operator's skill is published in (NA / EU / FE). Drives
   *  the Event Gateway URL. */
  readonly region: AlexaRegion
  /** Alexa users that have completed account-linking (cloud-mode
   *  `/oauth/lwa-tokens` callback). Hidden state. */
  readonly linkedAccounts: readonly LinkedAccount[]
  /** Per-user LWA tokens harvested from the cloud-mode
   *  `/oauth/lwa-tokens` callback for the Event Gateway. Hidden state. */
  readonly tokens: readonly LwaTokenEntry[]
  /**
   * Per-device map of the Alexa endpoint ids we last pushed (deviceId →
   * endpoint ids). The single piece of sync state the `SyncEngine` owns: a
   * push records what it sent here, and a later `DeleteReport` addresses these
   * exact ids even after the device is gone from the registry. Replaces the
   * fingerprint-diff reconcile cache + synced-account latch the old sync
   * machinery used.
   */
  readonly exportedEndpoints: Readonly<Record<number, readonly string[]>>
  /**
   * Per-device map of the endpoint SHAPE we last pushed (deviceId →
   * `endpointsSignature(...)`). Alexa's copy of an endpoint's capability list
   * is refreshed by NOTHING but an `AddOrUpdateReport` from us, so this is the
   * only way to know whether the cloud still believes a stale shape: a camera
   * that gains the `doorbell` cap after it was exposed keeps a cloud-side
   * endpoint with no `Alexa.DoorbellEventSource`, and every press is then
   * accepted (2xx) and silently discarded. See `sync-engine.ts`.
   */
  readonly exportedSignatures: Readonly<Record<number, string>>
  /**
   * Shared ingress token the user-owned Lambda presents (header
   * `X-CamStack-Ingress`) on its server-to-server hub calls. Generated on
   * first boot; rotated via the "Regenerate token" action. Defense-in-depth
   * on top of the per-user OAuth bearer — see `ingress-token.ts`. Custom skill
   * only: the public skill's shared Lambda cannot carry a per-hub token.
   */
  readonly ingressToken: string
  /**
   * When true, `/directive` + `/oauth/lwa-tokens` reject calls lacking a
   * matching ingress token. Off by default so the token can be rolled into
   * the Lambda before enforcement is switched on. Ignored in public mode
   * (`effectiveAlexaSettings`).
   */
  readonly enforceIngressToken: boolean
  /**
   * Per linked account, the exposed devices its hub user may view (S1, D767).
   * Hidden state, owned by `AccountVisibilityMirror`: the event path reads it
   * synchronously, and a loss persisted here survives a restart until the
   * confirming read deletes the device from that user's Alexa account.
   */
  readonly accountVisibility: StoredVisibilityMap
  /**
   * Integration switch, default ON: the master gate of the detection sensors
   * (R1, D772). WHICH classes a camera publishes is a per-camera choice since
   * D778 (`detection-sensors/sensor-selection.ts`, default none); this switch
   * still removes every one of them at once (DeleteReport).
   */
  readonly detectionSensors: boolean
  /** Per camera, the detection classes last published, with pending
   *  removals (`DetectionClassSource`). Hidden state. */
  readonly detectionClasses: StoredDetectionClassMap
  /**
   * Integration switch, default ON (operator decision, 2026-10-08): every
   * exposed camera declares `Alexa.SmartVision.SnapshotProvider`, so the Alexa
   * app shows its still (R2, D773). Images of the home go to Amazon while it is
   * on. Off removes the capability and kills every URL already handed out.
   */
  readonly snapshots: boolean
  /** HMAC key for snapshot URLs. Hidden; generated on first boot; never on a
   *  read surface. */
  readonly snapshotSigningKey: string
  /**
   * Integration switch, default ON (operator decision, 2026-10-08): every
   * exposed camera declares `Alexa.SmartVision.ObjectDetectionSensor` +
   * `Alexa.DataController` and posts person/package events (R4, D779). An
   * en-US-only interface, on as an experiment; this is the one switch that
   * takes it off every camera (the next push re-sends the camera without it).
   */
  readonly objectDetection: boolean
  /** UUID namespace of this hub's object/event identifiers (R4). Hidden;
   *  generated on first boot. */
  readonly visionNamespace: string
}

export const DEFAULT_CONFIG: AlexaSettings = {
  skillMode: 'public',
  expectedAudience: '',
  lwaClientId: '',
  lwaClientSecret: '',
  advertisedBrokerUrl: '',
  region: 'NA',
  linkedAccounts: [],
  tokens: [],
  exportedEndpoints: {},
  exportedSignatures: {},
  ingressToken: '',
  enforceIngressToken: false,
  accountVisibility: {},
  detectionSensors: true,
  detectionClasses: {},
  snapshots: true,
  snapshotSigningKey: '',
  objectDetection: true,
  visionNamespace: '',
}

/**
 * Settings as the runtime reads them. In `skillMode: 'public'` the skill id is the built-in
 * skill's, and the ingress token is never required of the DEFAULT instance: the public skill's
 * Lambda is shared by every hub and sends one `HUB_INGRESS_TOKEN` for all of them, so enforcing a
 * per-hub token would refuse every directive. A skill added later (`legacyInstance` false) is
 * reached through its own URL or its own token, and keeps the enforcement stored on it. The
 * persisted values stay untouched, so switching back to `custom` restores them.
 */
export function effectiveAlexaSettings(
  config: AlexaSettings,
  legacyInstance: boolean = true,
): AlexaSettings {
  if (config.skillMode !== 'public') return config
  return {
    ...config,
    expectedAudience: PUBLIC_SKILL_ID,
    enforceIngressToken: legacyInstance ? false : config.enforceIngressToken,
  }
}
