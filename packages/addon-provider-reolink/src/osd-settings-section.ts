import {
  type ConfigBooleanField,
  type ConfigField,
  type ConfigInfoField,
  type ConfigSection,
  type ConfigSelectField,
  OPERATOR_WRITTEN_STALE_MS,
} from '@camstack/types'
import {
  formatOsdCoords,
  OSD_CORNER_LABELS,
  OSD_CORNERS,
  type OsdPositionReading,
  readOsdPosition,
} from '@apocaliss92/nodelink-js'
import type { ReolinkCameraConfig } from './schema.js'

/**
 * OSD overlay section for the Reolink parent-settings form — extracted pure
 * (same shape as `sessions-snapshot.ts`) so the tri-state resolution is
 * unit-testable without constructing a `ReolinkCamera`.
 *
 * The camera OWNS its overlay state (D224): the operator can flip it from the
 * Reolink app at any time, so the persisted `osdSnapshot` is only a mirror
 * with a freshness stamp. The reader (`getSettingsUISchema`) serves the
 * mirror immediately and revalidates behind the open when it is older than
 * `OPERATOR_WRITTEN_STALE_MS` — a read that fails changes nothing.
 *
 * `null` means "the camera did not report this" and it must SURVIVE to the
 * UI (D337 — a reading nobody has taken is null). The `boolean` form field
 * cannot express a third state, so unknown renders as a DISABLED switch with
 * a "not reported" description — never as a schema default, and specifically
 * never as ON.
 *
 * There is deliberately NO operator-override input here (D62-shape): the
 * driver config used to hold a second copy of these facts (`osd*` keys) that
 * shadowed the camera forever after one CamStack write. The snapshot is the
 * only source; a write invalidates it by triggering the post-save `osd`
 * slice re-read, so the form always shows what the camera actually holds.
 *
 * The overlay POSITIONS are now WRITABLE. The vocabulary was unknown while
 * the snapshot came from the lib's `getOsd` placeholder, which never read an
 * OSD command and reported an empty string for both positions on every
 * camera. Read through `getOsdDatetime` (cmd_id 44) the anchors turn out to
 * be a normalised 16.16 coordinate pair per overlay (decoded by the library's `readOsdPosition`),
 * and the four corner pairs are the only values observed in the fleet — so
 * the control offers exactly those four. A camera holding anything else
 * (a placement hand-dragged in the Reolink app) gets a `custom` option that
 * shows the raw pair and writes nothing, so the form can never silently move
 * an overlay it did not understand.
 */

type ReolinkDeviceCache = NonNullable<ReolinkCameraConfig['deviceCache']>

/** The persisted `deviceCache.osdSnapshot` slice (`getOsdDatetime`, cmd_id 44). */
export type OsdSnapshot = NonNullable<ReolinkDeviceCache['osdSnapshot']>

/**
 * The tri-state values the form serves. `null` = the camera has not reported
 * this fact — neither the schema default nor `??` may resurrect a boolean
 * for it.
 */
export interface OsdResolvedValues {
  readonly osdChannelEnabled: boolean | null
  readonly osdChannelName: string
  readonly osdChannelPosition: string | null
  readonly osdTimeEnabled: boolean | null
  readonly osdTimePosition: string | null
  readonly osdWatermark: boolean | null
}

/** The select value that means "leave the placement the camera holds". */
export const OSD_POSITION_KEEP = 'custom'

/**
 * The select value for one overlay: a corner name when the camera's anchor
 * IS a corner, {@link OSD_POSITION_KEEP} when it holds something else, and
 * `null` when it reported no anchor at all — which renders as a disabled
 * "not reported" control rather than a corner nobody read.
 */
function positionValue(reading: OsdPositionReading): string | null {
  switch (reading.kind) {
    case 'corner':
      return reading.corner
    case 'custom':
      return OSD_POSITION_KEEP
    case 'unknown':
      return null
  }
}

/** Rendering context for {@link buildOsdSection}. */
export interface OsdSectionOptions {
  /** True when this is a battery camera currently asleep — the slice cannot
   *  refresh until it wakes (reading would BE the wake, D173-family). */
  readonly sleeping: boolean
  /** Wall-clock now, injected for testability. */
  readonly now: number
}

/**
 * Camera snapshot → UNKNOWN (`null`). The last arm is the point: `?? true`
 * here is what rendered "the camera did not tell us" as an enabled overlay.
 * The snapshot is the ONLY input — the config keeps no copy to consult.
 */
export function resolveOsdValues(snapshot: OsdSnapshot | undefined): OsdResolvedValues {
  return {
    osdChannelEnabled: snapshot?.channelEnabled ?? null,
    osdChannelName: snapshot?.channelName ?? '',
    osdChannelPosition: positionValue(readOsdPosition(snapshot?.channelX, snapshot?.channelY)),
    osdTimeEnabled: snapshot?.timeEnabled ?? null,
    osdTimePosition: positionValue(readOsdPosition(snapshot?.timeX, snapshot?.timeY)),
    osdWatermark: snapshot?.watermark ?? null,
  }
}

/**
 * Reader-side staleness (D224). A snapshot persisted before freshness
 * tracking has no `fetchedAt` and is treated as stale — that is exactly the
 * adoption-frozen reading this module exists to retire.
 */
export function isOsdSnapshotStale(snapshot: OsdSnapshot | undefined, now: number): boolean {
  return now - (snapshot?.fetchedAt ?? 0) > OPERATOR_WRITTEN_STALE_MS
}

const OSD_UNKNOWN_DESCRIPTION = 'Not reported by the camera yet — the current state is unknown.'

const NEVER_WOKEN_SUFFIX = 'a sleeping battery camera is never woken to read settings.'

/**
 * A boolean overlay toggle. Unknown (`null`) renders disabled with an honest
 * description — the switch component shows `Boolean(null)` = off, and the
 * disabled + "not reported" pairing keeps that from reading as a claim.
 */
function osdToggle(
  key: string,
  label: string,
  value: boolean | null,
  baseDescription: string | undefined,
): ConfigBooleanField {
  const unknown = value === null
  const description = unknown
    ? baseDescription
      ? `${baseDescription} ${OSD_UNKNOWN_DESCRIPTION}`
      : OSD_UNKNOWN_DESCRIPTION
    : baseDescription
  return {
    type: 'boolean',
    key,
    label,
    default: value,
    style: 'switch',
    ...(description !== undefined ? { description } : {}),
    ...(unknown ? { disabled: true } : {}),
  }
}

/**
 * State banner shown when the operator is NOT looking at a current reading:
 *  - camera asleep and the mirror is stale → say what is shown and when it
 *    was read, and that the camera is not woken for this;
 *  - no reading has ever landed → say the toggles are unknown.
 * A fresh mirror on an awake camera renders no banner — serve-and-revalidate
 * keeps it honest silently.
 */
function buildOsdStateBanner(
  snapshot: OsdSnapshot | undefined,
  opts: OsdSectionOptions,
): ConfigInfoField | null {
  const stale = isOsdSnapshotStale(snapshot, opts.now)
  if (opts.sleeping && stale) {
    const content =
      snapshot === undefined
        ? `Camera is asleep and its OSD state has never been read — the toggles below are unknown until it wakes; ${NEVER_WOKEN_SUFFIX}`
        : snapshot.fetchedAt !== undefined
          ? `Camera is asleep — showing the OSD state last read ${new Date(snapshot.fetchedAt).toLocaleString()}. It refreshes when the camera wakes; ${NEVER_WOKEN_SUFFIX}`
          : `Camera is asleep — showing the last known OSD state (age unknown). It refreshes when the camera wakes; ${NEVER_WOKEN_SUFFIX}`
    return {
      type: 'info',
      key: 'osdSnapshotState',
      label: 'OSD state',
      labelKey: 'provider-reolink:osdStateBanner.osdSnapshotState.label',
      variant: 'warning',
      content,
    }
  }
  if (snapshot === undefined) {
    return {
      type: 'info',
      key: 'osdSnapshotState',
      label: 'OSD state',
      labelKey: 'provider-reolink:osdStateBanner.osdSnapshotState.label',
      variant: 'warning',
      content:
        'OSD state has not been read from this camera yet — unknown toggles are disabled until a read succeeds.',
    }
  }
  return null
}

/**
 * The position control for one overlay.
 *
 * The options are the four corners — the only anchors observed across the
 * fleet, and therefore the only ones we know the camera accepts. Two extra
 * states are rendered honestly instead of being invented:
 *
 *  - the camera reported an anchor that is not a corner (hand-dragged in the
 *    Reolink app): a leading "keep" option carries the raw pair in its label
 *    and writes no coordinate, so opening the form cannot move the overlay;
 *  - the camera reported no anchor at all: the select is DISABLED with a
 *    "not reported" description and a `null` default (D337) — an unknown
 *    placement must never render as a corner nobody read.
 */
function osdPositionSelect(
  key: string,
  label: string,
  value: string | null,
  reading: OsdPositionReading,
): ConfigSelectField {
  const unknown = value === null
  const cornerOptions = OSD_CORNERS.map((corner) => ({
    value: corner,
    label: OSD_CORNER_LABELS[corner],
  }))
  const options =
    reading.kind === 'custom'
      ? [
          {
            value: OSD_POSITION_KEEP,
            label: `Custom — as placed on the camera (${formatOsdCoords(reading.x, reading.y)})`,
          },
          ...cornerOptions,
        ]
      : cornerOptions
  return {
    type: 'select',
    key,
    label,
    default: value,
    options,
    description: unknown
      ? OSD_UNKNOWN_DESCRIPTION
      : 'Where the camera anchors this overlay in the frame.',
    ...(unknown ? { disabled: true } : {}),
  }
}

/**
 * The "OSD overlay" section (writable via `setOsdDatetime`, cmd_id 45). One
 * push covers every field: the lib read-modify-writes the camera's own XML,
 * so a patch naming only the touched keys preserves everything else verbatim.
 */
export function buildOsdSection(
  snapshot: OsdSnapshot | undefined,
  values: OsdResolvedValues,
  opts: OsdSectionOptions,
): ConfigSection {
  const banner = buildOsdStateBanner(snapshot, opts)
  const fields: readonly ConfigField[] = [
    ...(banner ? [banner] : []),
    osdToggle('osdChannelEnabled', 'Channel name overlay', values.osdChannelEnabled, undefined),
    osdPositionSelect(
      'osdChannelPosition',
      'Channel name position',
      values.osdChannelPosition,
      readOsdPosition(snapshot?.channelX, snapshot?.channelY),
    ),
    {
      type: 'text',
      key: 'osdChannelName',
      label: 'Channel name',
      labelKey: 'provider-reolink:fields.osdChannelName.label',
      default: values.osdChannelName,
      placeholder: 'Front door',
    },
    osdToggle('osdTimeEnabled', 'Timestamp overlay', values.osdTimeEnabled, undefined),
    osdPositionSelect(
      'osdTimePosition',
      'Timestamp position',
      values.osdTimePosition,
      readOsdPosition(snapshot?.timeX, snapshot?.timeY),
    ),
    osdToggle(
      'osdWatermark',
      'Watermark',
      values.osdWatermark,
      'The Reolink logo watermark overlay.',
    ),
  ]
  return {
    id: 'osd',
    tab: 'image',
    title: 'OSD overlay',
    titleKey: 'provider-reolink:osdSection.s_osd.title',
    description:
      'An overlay the camera holds somewhere else keeps that placement unless a corner is chosen.',
    descriptionKey: 'provider-reolink:osdSection.s_osd.description',
    columns: 2,
    fields,
  }
}
