/**
 * Hub-side rules for the `apple-foundation` profile kind.
 *
 *   - The row names a NODE (`providerConfig.nodeId`) and nothing else; `model`
 *     is always `apple-system`.
 *   - `supportsVision` is what that node last REPORTED (`imageInput`), read
 *     from the hub's `AppleNodeMirror` on every read that decides with it —
 *     never a live cross-node call on a dispatch path. Unknown is not yes. The
 *     node re-checks on every call.
 *   - Identity / biometric work never reaches it. Apple's acceptable-use terms
 *     prohibit biometric classification of individuals; a consumer whose tag
 *     says that is what it does is refused before dispatch.
 */
import type { AppleFmAvailability, LlmProfile } from '@camstack/types'
import { appleNodeIdOf } from './kinds/provider-config.js'
import { APPLE_SYSTEM_MODEL } from './runtime/apple/afm-protocol.js'

/**
 * Words that, as a WHOLE segment of a consumer tag, say its purpose is
 * recognising who someone is. Whole segments, not substrings: `interface`
 * and `surface` contain "face" and are nothing of the kind.
 */
const IDENTITY_SEGMENTS: ReadonlySet<string> = new Set([
  'face',
  'faces',
  'facial',
  'biometric',
  'biometrics',
  'identity',
  'identities',
  'identify',
  'identification',
  'reid',
])

/** `face-identity`, `faces`, `person_reid` → true; `notifier-interface` → false. */
export function isIdentityConsumer(consumer: string): boolean {
  const segments = consumer.toLowerCase().split(/[^a-z0-9]+/)
  if (segments.some((segment) => IDENTITY_SEGMENTS.has(segment))) return true
  // `re-id` splits into two segments; it is still person re-identification.
  return /(?:^|[^a-z0-9])re[-_]id(?:$|[^a-z0-9])/i.test(consumer)
}

/** What the provider reads about Apple nodes — synchronously, never awaited. */
export interface AppleNodeView {
  /** Last known state; `undefined` = unknown. */
  get(nodeId: string): AppleFmAvailability | undefined
  /** The registry answered and does not list the node. */
  isKnownOffline(nodeId: string): boolean
  observe(nodeId: string, availability: AppleFmAvailability): void
}

function seesImages(availability: AppleFmAvailability | undefined): boolean {
  return availability?.state === 'available' && availability.imageInput
}

/**
 * The row as it may be stored. Throws on a row that names no node, or a node
 * whose last report says it is not a Mac. A node that is merely unavailable
 * (Apple Intelligence off, model downloading), offline or not yet known may be
 * saved — that is a state that changes, not a wrong choice. Reads the mirror:
 * a save never dials a node that may be offline.
 */
export function stampAppleProfile(
  profile: LlmProfile,
  nodes: AppleNodeView | undefined,
): LlmProfile {
  const nodeId = appleNodeIdOf(profile)
  if (nodeId === null) {
    throw new Error('an apple-foundation profile needs the node it runs on')
  }
  const availability = nodes?.get(nodeId)
  if (availability?.state === 'unsupported-platform') {
    throw new Error(
      `node "${nodeId}" cannot run Apple Foundation Models (${availability.platform})`,
    )
  }
  return { ...profile, model: APPLE_SYSTEM_MODEL, supportsVision: seesImages(availability) }
}

/**
 * `supportsVision` on every apple-foundation row, from the node's LAST REPORT
 * in the mirror — never from a live read (a live nodePin to an offline Mac
 * stalled every vision call on the hub for 30 s). A node that gains image
 * input needs no re-save; unknown is not yes.
 */
export function withAppleVision(
  profiles: readonly LlmProfile[],
  nodes: AppleNodeView | undefined,
): LlmProfile[] {
  return profiles.map((p) => {
    const nodeId = appleNodeIdOf(p)
    return nodeId !== null ? { ...p, supportsVision: seesImages(nodes?.get(nodeId)) } : p
  })
}
