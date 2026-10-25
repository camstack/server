import type { ConfigInfoField, ConfigSection } from '@camstack/types'
import type { ReolinkCameraConfig } from './schema.js'

/**
 * Per-snapshot freshness (D224 generalised — a device fact carries its own
 * window; D346). `deviceCache` holds one snapshot group per Baichuan read
 * (`encSnapshot`, `osdSnapshot`, …) but historically ONE `probedAt` for the
 * whole cache, so an operator could not tell whether a group was read a
 * minute ago or frozen at adoption — exactly the confusion behind the OSD
 * overlay bug (a settings form served an adoption-moment reading as if it
 * were current).
 *
 * This module is pure (same extraction shape as `osd-settings-section.ts` /
 * `sessions-snapshot.ts`) and owns:
 *   - the stamp writer helper (`stampSnapshotFreshness`) every snapshot
 *     persist site calls with the keys it actually wrote;
 *   - the tri-state age resolution (`resolveSnapshotAge`): a group with no
 *     stamp is of UNKNOWN age — it must never read as fresh (the same
 *     discipline as `isOsdSnapshotStale`, which treats a stampless snapshot
 *     as stale);
 *   - the read-only "Snapshot freshness" settings section that surfaces the
 *     ages to the operator.
 *
 * The stamps live in `deviceCache.snapshotFetchedAt`, keyed by the
 * deviceCache FIELD NAME of the group. They are written only where the
 * group itself is written — never refreshed by a read, never polled.
 */

type ReolinkDeviceCache = NonNullable<ReolinkCameraConfig['deviceCache']>

/** Wall-clock ms stamps, keyed by deviceCache snapshot field name. */
export type SnapshotFreshnessMap = Record<string, number>

/**
 * The snapshot groups the freshness panel reports on, with the Baichuan
 * read behind each. Order is the display order.
 */
export const SNAPSHOT_GROUPS: ReadonlyArray<{
  readonly key: string
  readonly label: string
  readonly labelKey?: string
}> = [
  {
    key: 'imageSnapshot',
    label: 'Image (getVideoInput)',
    labelKey: 'provider-reolink:snapshot_groups.imageSnapshot.label',
  },
  {
    key: 'motionSnapshot',
    label: 'Motion (getMotionAlarm)',
    labelKey: 'provider-reolink:snapshot_groups.motionSnapshot.label',
  },
  {
    key: 'aiSensitivitySnapshot',
    label: 'AI sensitivity (getAiDetectionFull)',
    labelKey: 'provider-reolink:snapshot_groups.aiSensitivitySnapshot.label',
  },
  {
    key: 'encSnapshot',
    label: 'Encoder (getEnc)',
    labelKey: 'provider-reolink:snapshot_groups.encSnapshot.label',
  },
  {
    key: 'encOptionsSnapshot',
    label: 'Encoder options (getEncOptions)',
    labelKey: 'provider-reolink:snapshot_groups.encOptionsSnapshot.label',
  },
  {
    key: 'maskSnapshot',
    label: 'Privacy mask (getMask)',
    labelKey: 'provider-reolink:snapshot_groups.maskSnapshot.label',
  },
  {
    key: 'audioNoiseSnapshot',
    label: 'Audio noise (getAudioNoise)',
    labelKey: 'provider-reolink:snapshot_groups.audioNoiseSnapshot.label',
  },
  {
    key: 'autoFocusSnapshot',
    label: 'Auto-focus (getAutoFocus)',
    labelKey: 'provider-reolink:snapshot_groups.autoFocusSnapshot.label',
  },
  {
    key: 'netPortSnapshot',
    label: 'Network ports (getNetPort)',
    labelKey: 'provider-reolink:snapshot_groups.netPortSnapshot.label',
  },
  {
    key: 'ntpSnapshot',
    label: 'NTP (getNtp)',
    labelKey: 'provider-reolink:snapshot_groups.ntpSnapshot.label',
  },
  {
    key: 'systemGeneralSnapshot',
    label: 'System general (getSystemGeneral)',
    labelKey: 'provider-reolink:snapshot_groups.systemGeneralSnapshot.label',
  },
  {
    key: 'osdSnapshot',
    label: 'OSD overlay (getOsd)',
    labelKey: 'provider-reolink:snapshot_groups.osdSnapshot.label',
  },
  {
    key: 'ledSnapshot',
    label: 'LEDs (getIrLights)',
    labelKey: 'provider-reolink:snapshot_groups.ledSnapshot.label',
  },
  {
    key: 'pirSnapshot',
    label: 'PIR (getPirInfo)',
    labelKey: 'provider-reolink:snapshot_groups.pirSnapshot.label',
  },
  {
    key: 'autoRebootSnapshot',
    label: 'Auto reboot (getAutoReboot)',
    labelKey: 'provider-reolink:snapshot_groups.autoRebootSnapshot.label',
  },
  {
    key: 'emailConfigSnapshot',
    label: 'Email/SMTP (getEmail)',
    labelKey: 'provider-reolink:snapshot_groups.emailConfigSnapshot.label',
  },
  {
    key: 'capOptionsSnapshot',
    label: 'Cap option probes (getOptions)',
    labelKey: 'provider-reolink:snapshot_groups.capOptionsSnapshot.label',
  },
] as const

/**
 * Merge freshness stamps for the snapshot keys a persist actually wrote.
 * Returns a NEW map (immutability) — previous stamps for untouched groups
 * survive, written groups are stamped `now`. Call this from the same
 * `setAll` that writes the snapshots, with exactly the keys being written:
 * a failed probe writes no snapshot and therefore gets no stamp.
 */
export function stampSnapshotFreshness(
  previous: SnapshotFreshnessMap | undefined,
  writtenKeys: readonly string[],
  now: number,
): SnapshotFreshnessMap {
  const stamped: SnapshotFreshnessMap = { ...previous }
  for (const key of writtenKeys) stamped[key] = now
  return stamped
}

/** Tri-state age of one snapshot group (D337-family: unknown stays unknown). */
export type SnapshotAge =
  /** The group has never been written — there is nothing to show. */
  | { readonly state: 'never' }
  /** The group exists but predates per-snapshot stamping — its age is
   *  unknown and must never be presented as fresh. */
  | { readonly state: 'unknown' }
  /** The group carries a stamp. */
  | { readonly state: 'known'; readonly fetchedAt: number; readonly ageMs: number }

/**
 * Resolve the age of one snapshot group from the cache. Sources, in order:
 *   1. `snapshotFetchedAt[key]` — the generic stamp map;
 *   2. a group-embedded stamp where one already existed before the map
 *      (`osdSnapshot.fetchedAt`, `emailConfigSnapshot.lastReadAt`,
 *      newest `capOptionsSnapshot[*].fetchedAt`);
 *   3. otherwise: the group is present but of unknown age.
 * An absent group is `never` — not-yet-read must never look like read.
 */
export function resolveSnapshotAge(
  cache: ReolinkDeviceCache | undefined,
  key: string,
  now: number,
): SnapshotAge {
  const group: unknown = cache === undefined ? undefined : Reflect.get(cache, key)
  if (group === undefined) return { state: 'never' }
  const mapStamp = cache?.snapshotFetchedAt?.[key]
  const stamp = typeof mapStamp === 'number' ? mapStamp : embeddedStamp(cache, key)
  if (typeof stamp !== 'number') return { state: 'unknown' }
  return { state: 'known', fetchedAt: stamp, ageMs: Math.max(0, now - stamp) }
}

/** Pre-map stamps some groups already carried; kept as fallback so a legacy
 *  cache written by today's OSD fix still reports a real age. */
function embeddedStamp(cache: ReolinkDeviceCache | undefined, key: string): number | undefined {
  if (key === 'osdSnapshot') {
    const v = cache?.osdSnapshot?.fetchedAt
    return typeof v === 'number' ? v : undefined
  }
  if (key === 'emailConfigSnapshot') {
    const v = cache?.emailConfigSnapshot?.lastReadAt
    return typeof v === 'number' ? v : undefined
  }
  if (key === 'capOptionsSnapshot') {
    const entries = Object.values(cache?.capOptionsSnapshot ?? {})
    const stamps = entries
      .map((e) => e?.fetchedAt)
      .filter((v): v is number => typeof v === 'number')
    return stamps.length > 0 ? Math.max(...stamps) : undefined
  }
  return undefined
}

/** Human age: "12 s ago", "3 m ago", "5 h ago", "12 d ago". */
export function formatSnapshotAge(ageMs: number): string {
  const s = Math.floor(ageMs / 1000)
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

/** One display line for a group. Unknown age is SAID, never smoothed over. */
export function formatSnapshotAgeLine(label: string, age: SnapshotAge): string {
  switch (age.state) {
    case 'never':
      return `${label}: never read`
    case 'unknown':
      return `${label}: age unknown (recorded before per-snapshot freshness tracking)`
    case 'known':
      return `${label}: read ${formatSnapshotAge(age.ageMs)} (${new Date(age.fetchedAt).toLocaleString()})`
  }
}

/** Rendering context for {@link buildSnapshotFreshnessSection}. */
export interface SnapshotFreshnessSectionOptions {
  /** Battery camera currently asleep — nothing here can refresh until it
   *  wakes; the panel says so instead of implying a refresh button helps. */
  readonly sleeping: boolean
  /** Wall-clock now, injected for testability. */
  readonly now: number
}

/**
 * Read-only "Snapshot freshness" section (advanced tab, next to Debug).
 * Lists every snapshot group with its own age so "is CamStack's belief
 * current?" is answerable per fact, not per cache. Purely informational:
 * it triggers no reads — refresh stays on the existing operator-triggered
 * "Refresh from camera" action and the event-driven paths.
 */
export function buildSnapshotFreshnessSection(
  cache: ReolinkDeviceCache | undefined,
  opts: SnapshotFreshnessSectionOptions,
): ConfigSection {
  const lines = SNAPSHOT_GROUPS.map(({ key, label }) =>
    formatSnapshotAgeLine(label, resolveSnapshotAge(cache, key, opts.now)),
  )
  const probedAt = cache?.probedAt
  const header =
    typeof probedAt === 'number'
      ? `Feature probe: ${new Date(probedAt).toLocaleString()}`
      : 'Feature probe: never recorded'
  const sleepNote = opts.sleeping
    ? 'Camera is asleep — no group can refresh until it wakes; a sleeping battery camera is never woken to read settings.\n'
    : ''
  const field: ConfigInfoField = {
    type: 'info',
    key: 'snapshotFreshness',
    label: 'Per-snapshot read times',
    labelKey: 'provider-reolink:field.snapshotFreshness.label',
    content: `${sleepNote}${header}\n${lines.join('\n')}`,
  }
  return {
    id: 'snapshotFreshness',
    tab: 'advanced',
    title: 'Snapshot freshness',
    titleKey: 'provider-reolink:snapshotFreshnessSection.s_snapshotFreshness.title',
    description: 'Groups without a stamp are of unknown age, not fresh.',
    descriptionKey: 'provider-reolink:snapshotFreshnessSection.s_snapshotFreshness.description',
    columns: 1,
    fields: [field],
  }
}
