/**
 * What the custom component in Home Assistant can actually BUILD.
 *
 * The hub ships in one train and the component in another: an operator
 * updates the integration through HACS, when they decide to. So the hub
 * cannot assume the platforms it knows about exist on the other side — a
 * `cover` announced to a 0.3.x component produces one warning line in
 * Home Assistant's log and NO entity, which from the operator's side is
 * indistinguishable from "camstack exported nothing".
 *
 * So the component says what it builds. `GET /api/camstack/version`
 * answers `{version, platforms}`, and the negotiation gates on the
 * PLATFORM LIST rather than on a version comparison: a table here mapping
 * versions to platforms would be a second copy of a fact the component
 * already knows, and it would rot on the first release that adds one.
 * The version travels for the log line and for nothing else.
 *
 * ── The one rule that is not obvious ────────────────────────────────────
 *
 * An UPGRADE applies at once; a DOWNGRADE needs two consecutive reads that
 * agree. Losing a platform migrates every entity built on it — a native
 * `cover` becomes three sensors, and Home Assistant's registry entry, its
 * history and every automation pointing at it go with the old entity id.
 * That is destructive work driven by a fallible read, which is D49: one
 * bad answer (a proxy 404, a restart mid-request, a token being rotated)
 * must not be able to cost an operator their entities. A component that
 * really was downgraded is picked up on the next pass, one reconcile
 * later.
 */
import type { HaPlatform } from './types.js'

/** Where the component publishes what it builds. A wire format. */
export const COMPONENT_VERSION_PATH = '/api/camstack/version'

/**
 * The platforms every released component builds.
 *
 * Assumed when the component does not answer the probe at all, which is
 * exactly what 0.3.x and older do: the endpoint arrived with the native
 * platforms. `alarm_control_panel` is deliberately ABSENT — the export has
 * been emitting it since T1 and the 0.3.x component never built it, so
 * assuming it here would keep an alarm panel invisible on the very
 * installations this list exists to protect.
 */
export const LEGACY_PLATFORMS: readonly HaPlatform[] = [
  'binary_sensor',
  'sensor',
  'image',
  'switch',
  'button',
  'select',
  'camera',
  'number',
]

/** The platforms a component builds. */
export type PlatformSupport = ReadonlySet<HaPlatform>

export const LEGACY_SUPPORT: PlatformSupport = new Set(LEGACY_PLATFORMS)

/**
 * What the catalog assumes when NOBODY asked.
 *
 * Deliberately not {@link LEGACY_SUPPORT}: the platforms the degraded
 * tables themselves name, which is exactly the behaviour the export had
 * before any of this existed. A caller that does not negotiate therefore
 * gets what it always got — no native platforms, and no degradation
 * either. Both changes are decisions the NEGOTIATION makes, on an answer
 * from the Home Assistant that has to build them, and neither is a
 * default a test fixture or a future caller can trip over by accident.
 */
export const UNNEGOTIATED_SUPPORT: PlatformSupport = new Set<HaPlatform>([
  ...LEGACY_PLATFORMS,
  'alarm_control_panel',
])

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set<HaPlatform>([
  'binary_sensor',
  'sensor',
  'image',
  'switch',
  'button',
  'select',
  'camera',
  'alarm_control_panel',
  'number',
  'notify',
  'cover',
  'climate',
  'lock',
  'fan',
  'vacuum',
  'valve',
  'humidifier',
  'water_heater',
  'media_player',
])

function isKnownPlatform(value: string): value is HaPlatform {
  return KNOWN_PLATFORMS.has(value)
}

/** What the component answered. */
export interface ComponentReport {
  /** Informational — the negotiation gates on `platforms`. */
  readonly version: string | null
  readonly platforms: PlatformSupport
}

/**
 * The three answers a probe can produce, and they are three for a reason.
 *
 * `absent` is the component saying "I have no such endpoint", which is
 * information: it is an OLD component. `unknown` is the network saying
 * nothing — a timeout, a 500, a token being rotated — which is not
 * information and must never move anything.
 */
export type ComponentProbe =
  | { readonly kind: 'reported'; readonly report: ComponentReport }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown'; readonly error: string }

/**
 * Parse the component's answer.
 *
 * A platform this hub does not know is DROPPED rather than refused: the
 * component ships on its own train and may well build something newer
 * than this hub can emit, and refusing the whole report over one unknown
 * name would downgrade every entity on that installation.
 */
export function parseComponentReport(body: unknown): ComponentReport | null {
  if (body === null || typeof body !== 'object') return null
  const raw: unknown = Reflect.get(body, 'platforms')
  if (!Array.isArray(raw)) return null
  const platforms = new Set<HaPlatform>()
  for (const entry of raw) {
    if (typeof entry === 'string' && isKnownPlatform(entry)) platforms.add(entry)
  }
  if (platforms.size === 0) return null
  const version: unknown = Reflect.get(body, 'version')
  return { version: typeof version === 'string' ? version : null, platforms }
}

/** Stable, comparable text for a support set. Used for change detection. */
export function supportSignature(support: PlatformSupport): string {
  return [...support].sort().join(',')
}

/**
 * The platforms every one of these components builds.
 *
 * A device exported to two Home Assistant instances is announced ONCE, so
 * a platform only one of them builds cannot be used: the other would
 * receive a component it drops on the floor. Two instances on different
 * component versions is the case this exists for, and the cost is that
 * the newer one waits for the older to be updated — visible in the log,
 * and never an entity that silently does not arrive.
 */
export function intersectSupport(supports: readonly PlatformSupport[]): PlatformSupport {
  const [first, ...rest] = supports
  if (first === undefined) return LEGACY_SUPPORT
  const out = new Set<HaPlatform>()
  for (const platform of first) {
    if (rest.every((other) => other.has(platform))) out.add(platform)
  }
  return out
}

export interface SupportChange {
  readonly support: PlatformSupport
  /** True when this observation moved the negotiated set. */
  readonly changed: boolean
  /** Set when a downgrade was WITHHELD, waiting for a second agreeing read. */
  readonly withheldDowngrade: boolean
}

/**
 * Per-broker negotiated support, with the downgrade rule.
 *
 * Pure and injectable-free: the probe is somebody else's job, this only
 * decides what a sequence of answers means.
 */
export class ComponentSupportTracker {
  private readonly current = new Map<string, PlatformSupport>()
  /** brokerId → the signature of the downgrade that has been seen once. */
  private readonly pendingDowngrade = new Map<string, string>()

  /** The support in force for a broker. Legacy until something says otherwise. */
  supportFor(brokerId: string): PlatformSupport {
    return this.current.get(brokerId) ?? LEGACY_SUPPORT
  }

  /** The support in force for a set of brokers, intersected. */
  supportForAll(brokerIds: readonly string[]): PlatformSupport {
    if (brokerIds.length === 0) return LEGACY_SUPPORT
    return intersectSupport(brokerIds.map((id) => this.supportFor(id)))
  }

  forget(brokerId: string): void {
    this.current.delete(brokerId)
    this.pendingDowngrade.delete(brokerId)
  }

  observe(brokerId: string, probe: ComponentProbe): SupportChange {
    const before = this.supportFor(brokerId)
    if (probe.kind === 'unknown') {
      // No information. Deliberately not even a cleared downgrade: a
      // timeout between two agreeing 404s does not make them disagree.
      return { support: before, changed: false, withheldDowngrade: false }
    }
    const next = probe.kind === 'absent' ? LEGACY_SUPPORT : probe.report.platforms
    const signature = supportSignature(next)
    if (signature === supportSignature(before)) {
      this.pendingDowngrade.delete(brokerId)
      this.current.set(brokerId, next)
      return { support: before, changed: false, withheldDowngrade: false }
    }

    const loses = [...before].some((platform) => !next.has(platform))
    if (loses && this.pendingDowngrade.get(brokerId) !== signature) {
      this.pendingDowngrade.set(brokerId, signature)
      return { support: before, changed: false, withheldDowngrade: true }
    }
    this.pendingDowngrade.delete(brokerId)
    this.current.set(brokerId, next)
    return { support: next, changed: true, withheldDowngrade: false }
  }
}
