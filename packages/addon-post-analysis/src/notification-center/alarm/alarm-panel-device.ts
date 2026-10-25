/**
 * The Notification Center's own alarm panel.
 *
 * A REAL device, not a special case: it carries `alarm-panel` natively, so the
 * `deviceState` rule gate reads it through `loadRuntimeState` exactly like a
 * switch or a contact, and both exporters see it through their ordinary
 * device mapping. Nothing had to learn about alarms.
 *
 * It needed no new addon and no base-class change either — the wiring already
 * existed and was simply never used this way: `ctx.kernel.devices.create()` is
 * on EVERY addon's kernel services, not only a `BaseDeviceProvider`'s, and
 * `integrations.create` gives it a fixed home to hang from.
 *
 * The lifecycle lives in {@link ../alarm-state-machine.js} as pure functions.
 * This class is the thin part: persist the machine, publish the derived state,
 * and re-publish when a delay elapses.
 */

import {
  type AlarmArmMode,
  AlarmArmModeSchema,
  type AlarmPanelStatus,
  type AlarmState,
  alarmPanelCapability,
  applyBlockingEdit,
  applyModeDelaysEdits,
  applyNonBlockingEdit,
  applySecureOnArmEdit,
  alarmDeviceSecureOnArm,
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  DeviceType,
  type InferNativeProvider,
  NC_ALARM_DELAY_FIELDS,
  NC_ALARM_NOTIFY_FIELDS,
  type NcAlarmDelaySettings,
  type NcAlarmModeDelays,
  type NcAlarmModeDelaysEdit,
  type NcAlarmResolvedDelays,
  type NcAlarmSettings,
  type NcAlarmSettingsPatch,
  type NcAlarmProfilesState,
  type NcAlarmProfilesView,
  type NcAlarmProfileCreateSource,
  activateAlarmProfile as activateAlarmProfilePure,
  cloneAlarmSettings,
  createAlarmProfile as createAlarmProfilePure,
  deleteAlarmProfile as deleteAlarmProfilePure,
  derivePostTriggeredAction,
  ensureAlarmProfiles,
  isDefaultAlarmProfileId,
  isScheduleActive,
  NC_ALARM_DEFAULT_PROFILE_ID,
  renameAlarmProfile as renameAlarmProfilePure,
  type NcAlarmModeNotifyPolicy,
  resolveModeDelays,
  resolveModeNotifyPolicy,
  syncActiveAlarmProfileSettings,
} from '@camstack/types'
import { z } from 'zod'
import {
  ARM_ANYWAY_TTL_MS,
  decideArm,
  type NcAlarmArmAnywayRejection,
  type NcAlarmArmOutcome,
  NcAlarmArmRefusedError,
  type NcAlarmArmVerdict,
  type NcAlarmOpenDevice,
} from './alarm-arm-guard.js'
import { NcAlarmExclusions, type NcExclusionReading } from './alarm-exclusions.js'
import {
  type NcAlarmInputBypassRecord,
  type NcAlarmInputBypassRequest,
  NcAlarmInputBypasses,
} from './alarm-input-bypasses.js'
import { armModeOf } from './alarm-mode-coverage.js'
import { modeDelaysFromPersisted } from './alarm-mode-delays.js'
import {
  type AlarmDelays,
  type AlarmMachine,
  arm,
  DEFAULT_DELAYS,
  DISARMED,
  disarm,
  exitDelayAt,
  isArmed,
  pendingAt,
  settle,
  stateAt,
  trigger,
} from './alarm-state-machine.js'
import { intrusionDeviceOf, type NcAlarmMatchPhase } from './alarm-push-policy.js'
import {
  alarmTransition,
  NC_ALARM_INCIDENT_MAX_FOLLOWERS,
  NcAlarmAttribution,
  type NcAlarmBypassedSensor,
  type NcAlarmFollowOutcome,
  type NcAlarmTransition,
  type NcAlarmTriggerSource,
  subjectKeyOf,
} from './alarm-transitions.js'

/** What {@link NcAlarmPanelDevice.observeOpening} did with one reading. */
export type NcObserveOpeningResult = 'unchanged' | 'closed' | 'lifted'

/**
 * What one press did: `accepted` (an entry delay started, or the siren), `refused` (the
 * state machine ignored it — exit delay, a running countdown, a siren, disarmed; logged),
 * `ignored-excluded` (the sensor was open when the alarm was armed; logged),
 * `ignored-bypassed` (the operator bypassed this rule's input until disarm; logged, counted).
 */
export type NcAlarmPressOutcome = 'accepted' | 'refused' | 'ignored-excluded' | 'ignored-bypassed'

/** A bypass request, plus when the notification it came from was about (the session check). */
export interface NcAlarmInputBypassInput extends NcAlarmInputBypassRequest {
  /**
   * When the match the request is about happened — the notification's own
   * instant. A request about a match from BEFORE the current arm session began
   * belongs to an arm that is over, and is refused `stale`. Absent ⇒ the
   * current session (an operator in the app, looking at the live view).
   */
  readonly notedAt?: number
}

/** Why a bypass request did nothing. */
export type NcAlarmInputBypassRefusal = 'disarmed' | 'stale' | 'full'

/** What one bypass request did. */
export type NcAlarmInputBypassOutcome =
  | {
      readonly outcome: 'bypassed' | 'already-bypassed'
      readonly bypassed: readonly NcAlarmInputBypassRecord[]
    }
  | { readonly outcome: 'refused'; readonly reason: NcAlarmInputBypassRefusal }

export interface NcObserveOpeningOptions {
  /**
   * D706: the caller evaluates the event that carried this reading next and announces the
   * lift itself afterwards ({@link NcAlarmPanelDevice.announceLifted}).
   */
  readonly deferLiftAnnouncement?: boolean
  /**
   * D735: the reading's OWN change time (a sensor event's slice), when the caller has one.
   * It decides only whether an excluded sensor really MOVED — see `NcAlarmExclusions.observe`.
   */
  readonly changedAt?: number
}

/** Every arm mode a camstack-owned panel offers. */
export const NC_ALARM_MODES: readonly AlarmArmMode[] = ['home', 'away', 'night']

/**
 * How often the panel re-publishes while a delay is running.
 *
 * The state is computed from an INSTANT, so this tick only decides how quickly
 * the change is ANNOUNCED — a missed tick can never leave the panel stuck in
 * `arming`. One second is what makes a countdown look like a countdown.
 */
const TICK_MS = 1000

/**
 * The panel's persisted config: the delays an operator tunes, and the machine
 * itself. The machine is persisted because the alternative is an alarm that
 * disarms itself on every deploy.
 */
const ncAlarmPanelSchema = z.object({
  exitDelaySec: z.number().int().min(0).max(600).default(DEFAULT_DELAYS.exitDelaySec),
  entryDelaySec: z.number().int().min(0).max(600).default(DEFAULT_DELAYS.entryDelaySec),
  triggeredDurationSec: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(DEFAULT_DELAYS.triggeredDurationSec),
  /**
   * What happens when the triggered window ends. Absent on older blobs →
   * derived from {@link triggeredDurationSec} at read time (never defaulted
   * here: a Zod default would force `doNothing` onto installs that already
   * had a positive `triggeredDurationSec` and silently stop re-arming).
   */
  postTriggeredAction: z.enum(['rearmAfter', 'disableAfter', 'doNothing']).optional(),
  /**
   * VESTIGIAL (D630): nothing reads it to decide anything any more — every
   * transition is announced to `announceTargets`. Kept so a persisted blob
   * and the settings cap still round-trip it, and read once at boot to tell
   * an operator who had it OFF that their targets now hear every transition.
   */
  announceArm: z.boolean().default(false),
  /** Target ids EVERY alarm announcement goes to — see `NcAlarmSettingsSchema`. */
  announceTargets: z.array(z.string()).default([]),
  machine: z.record(z.string(), z.unknown()).optional(),
  /**
   * Devices the CURRENT arm is ignoring because they were open when it armed
   * (tolerated by the mode's non-blocking list, or confirmed with Arm anyway),
   * and how far each is through its two-phase lift.
   *
   * Persisted for the same reason the machine is: a deploy in the middle of an
   * armed night would otherwise silently re-arm every sensor the operator
   * agreed to leave out, and they would learn about it from the siren. Read
   * back through a guard, never a cast — see `NcAlarmExclusions.restore`.
   */
  exclusions: z.array(z.unknown()).default([]),
  /**
   * The (rule, input) pairs the operator bypassed for the rest of THIS arm
   * session (`alarm-input-bypasses.ts`). Persisted for the exclusions' reason;
   * read back through a guard, never a cast.
   */
  inputBypasses: z.array(z.unknown()).default([]),
  /**
   * When the current arm session began (the last arm). A bypass request about a
   * match older than this belongs to an arm that is over. Absent on an older
   * blob ⇒ no session check until the next arm.
   */
  armSessionAt: z.number().optional(),
  /**
   * Per arm mode, the covered devices whose being open does not refuse the arm
   * (D630). Loose on purpose — `mode` is a string here — and read back through
   * {@link nonBlockingFromPersisted}, never a cast: a blob written by a later
   * release with a mode this one does not know must drop that entry, not the
   * whole config.
   */
  nonBlocking: z
    .array(z.object({ mode: z.string(), deviceIds: z.array(z.number().int()) }))
    .default([]),
  /**
   * Controllable openings that DO block when open (opt-in). Loose + guarded like
   * {@link nonBlocking}.
   */
  blocking: z
    .array(z.object({ mode: z.string(), deviceIds: z.array(z.number().int()) }))
    .default([]),
  /**
   * Controllable openings that must NOT secure on arm (opt-out). Loose + guarded
   * like {@link nonBlocking}.
   */
  secureOnArmOff: z
    .array(z.object({ mode: z.string(), deviceIds: z.array(z.number().int()) }))
    .default([]),
  /**
   * Per arm mode, the delays that override the global ones (D697). Loose on purpose — `mode` is
   * a string and the numbers are unbounded here — and read back through
   * {@link modeDelaysFromPersisted}, never a cast: an entry this release cannot trust is dropped
   * and logged at boot, never the whole config. A blob written before D697 has no key and
   * parses to no overrides.
   */
  modeDelays: z
    .array(
      z.object({
        mode: z.string(),
        exitDelaySec: z.number().optional(),
        entryDelaySec: z.number().optional(),
        triggeredDurationSec: z.number().optional(),
        /**
         * Loose, like `mode` — re-validated through {@link modeDelaysFromPersisted}. An enum here
         * would refuse to write back a foreign entry whose action a later release added.
         */
        postTriggeredAction: z.string().optional(),
        /** Loose — re-validated through {@link modeDelaysFromPersisted}. */
        schedule: z.unknown().optional(),
        /** D706 — the mode's notification switches; absent = off. */
        notifyDuringEntryDelay: z.boolean().optional(),
        notifySensorRewatched: z.boolean().optional(),
        notifySensorIgnored: z.boolean().optional(),
      }),
    )
    .default([]),
  /**
   * Active alarm configuration profile id. Empty / absent on a blob older than
   * profiles → seeded to Default on first read via {@link ensureAlarmProfiles}.
   */
  activeProfileId: z.string().default(NC_ALARM_DEFAULT_PROFILE_ID),
  /**
   * Named settings blobs. Loose on purpose — each profile's settings are
   * re-validated through {@link settingsBlobFromPersisted} so a corrupt entry
   * drops rather than taking down the panel.
   */
  profiles: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        settings: z.record(z.string(), z.unknown()),
      }),
    )
    .default([]),
})

/**
 * One refusal — what the Arm anyway on ITS notification is allowed to do.
 *
 * Held in RAM only, and only the LATEST one (see `armAnyway`). A refusal that
 * survived a restart would let a respawn arm around devices nobody re-read;
 * losing one costs one more tap.
 */
export interface NcAlarmRefusal {
  /**
   * `refusal:<panelId>:<mode>:<at>:<seq>` — unique per refusal (the sequence
   * keeps two refusals inside one millisecond apart), carried by the button
   * grant.
   */
  readonly id: string
  readonly mode: AlarmArmMode
  /** The EXACT blocking ids at refusal time — never re-read at press time. */
  readonly blockingIds: readonly number[]
  /**
   * The same devices as the operator was SHOWN them (name and state at refusal
   * time). What an Arm anyway excludes when its re-read cannot vouch for them.
   */
  readonly blocking: readonly NcAlarmOpenDevice[]
  readonly at: number
  /** `machine.changedAt` when refused; any panel transition since makes the refusal stale. */
  readonly panelChangedAt: number
}

/**
 * One mode's non-blocking list. Derived from the settings type rather than
 * imported: the `NcAlarmNonBlocking` type is not on the `@camstack/types` barrel
 * (only the cap file exports it), and adding it would be a framework change for
 * a name.
 */
type NcAlarmModeDeviceList = NcAlarmSettings['nonBlocking'][number]

/** One exclusion and which side of its two-phase lift it is on. */
export interface NcAlarmExclusionPhase {
  readonly deviceId: number
  readonly phase: 'open' | 'closed'
}

export type { NcAlarmArmAnywayRejection, NcAlarmArmOutcome } from './alarm-arm-guard.js'
/** Re-exported: the panel is where a reader of the refusal looks for it. */
export { ARM_ANYWAY_TTL_MS }

/**
 * Why an open device was armed around — logged per device.
 *  - `non-blocking`: the mode tolerates it (its non-blocking list);
 *  - `arm-anyway`: the operator confirmed it, and the re-read saw it open;
 *  - `arm-anyway-unverified`: confirmed, but the re-read failed outright;
 *  - `arm-anyway-unknown`: confirmed, and the re-read could not say (D49 —
 *    unknown is never counted secure).
 */
type NcArmExclusionWhy =
  | 'non-blocking'
  | 'secure-on-arm'
  | 'arm-anyway'
  | 'arm-anyway-unverified'
  | 'arm-anyway-unknown'

interface NcArmExclusion {
  readonly device: NcAlarmOpenDevice
  readonly why: NcArmExclusionWhy
}

/**
 * What the arm guard came back with:
 *  - `read` — the openings, and the verdict taken on them;
 *  - `unguarded` — no guard is wired; arm, silently (nothing was skipped);
 *  - `check-failed` — the read threw. The caller arms WITHOUT the check and
 *    announces it only AFTER the arm has landed ({@link announceUncheckedArm}):
 *    an Arm anyway that turns out stale arms nothing and must announce nothing.
 */
type NcArmGuardRead =
  | {
      readonly kind: 'read'
      readonly openings: NcAlarmOpenings
      readonly verdict: NcAlarmArmVerdict
    }
  | { readonly kind: 'unguarded' }
  | { readonly kind: 'check-failed'; readonly error: string }

/** The covered devices' openings, as the centre read them for one arm. */
export interface NcAlarmOpenings {
  /** Covered devices that read OPEN now. */
  readonly open: readonly NcAlarmOpenDevice[]
  /** Covered openings whose state could not be read — they never block. */
  readonly unknown: readonly number[]
}

/**
 * The persisted non-blocking lists, narrowed to modes that exist, first entry
 * per mode kept — the same "at most one list per mode" the settings schema
 * enforces at the boundary. A type guard (`safeParse`), never a cast.
 */
function modeDeviceListFromPersisted(
  raw: readonly { readonly mode: string; readonly deviceIds: readonly number[] }[],
): NcAlarmModeDeviceList[] {
  const seen = new Set<AlarmArmMode>()
  const lists: NcAlarmModeDeviceList[] = []
  for (const entry of raw) {
    const mode = AlarmArmModeSchema.safeParse(entry.mode)
    if (!mode.success || seen.has(mode.data)) continue
    seen.add(mode.data)
    lists.push({ mode: mode.data, deviceIds: [...entry.deviceIds] })
  }
  return lists
}

/** @deprecated Prefer {@link modeDeviceListFromPersisted} — same function. */
export function nonBlockingFromPersisted(
  raw: readonly { readonly mode: string; readonly deviceIds: readonly number[] }[],
): NcAlarmModeDeviceList[] {
  return modeDeviceListFromPersisted(raw)
}

/** One profile's settings as stored under the panel config — loose record. */
type PersistedProfileSettings = Record<string, unknown>

interface PersistedProfileRow {
  readonly id: string
  readonly name: string
  readonly settings: PersistedProfileSettings
}

/**
 * Rebuild a trusted {@link NcAlarmSettings} from a persisted profile blob.
 * Unknown / corrupt fields fall back to system-safe empties via the flat-key
 * readers the panel already uses for the live settings.
 */
function settingsBlobFromPersisted(raw: PersistedProfileSettings): NcAlarmSettings {
  const exit =
    typeof raw['exitDelaySec'] === 'number' ? raw['exitDelaySec'] : DEFAULT_DELAYS.exitDelaySec
  const entry =
    typeof raw['entryDelaySec'] === 'number' ? raw['entryDelaySec'] : DEFAULT_DELAYS.entryDelaySec
  const triggered =
    typeof raw['triggeredDurationSec'] === 'number'
      ? raw['triggeredDurationSec']
      : DEFAULT_DELAYS.triggeredDurationSec
  const announceTargets = Array.isArray(raw['announceTargets'])
    ? raw['announceTargets'].filter((t): t is string => typeof t === 'string')
    : []
  const lists = (key: string): NcAlarmModeDeviceList[] => {
    const v = raw[key]
    if (!Array.isArray(v)) return []
    const rows: { mode: string; deviceIds: number[] }[] = []
    for (const item of v) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      if (typeof rec['mode'] !== 'string' || !Array.isArray(rec['deviceIds'])) continue
      rows.push({
        mode: rec['mode'],
        deviceIds: rec['deviceIds'].filter((id): id is number => typeof id === 'number'),
      })
    }
    return modeDeviceListFromPersisted(rows)
  }
  const modeDelaysRaw = Array.isArray(raw['modeDelays']) ? raw['modeDelays'] : []
  const modeDelaysLoose: {
    mode: string
    exitDelaySec?: number
    entryDelaySec?: number
    triggeredDurationSec?: number
    postTriggeredAction?: string
    schedule?: unknown
    notifyDuringEntryDelay?: boolean
    notifySensorRewatched?: boolean
    notifySensorIgnored?: boolean
  }[] = []
  for (const item of modeDelaysRaw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec['mode'] !== 'string') continue
    const entry: {
      mode: string
      exitDelaySec?: number
      entryDelaySec?: number
      triggeredDurationSec?: number
      postTriggeredAction?: string
      schedule?: unknown
      notifyDuringEntryDelay?: boolean
      notifySensorRewatched?: boolean
      notifySensorIgnored?: boolean
    } = { mode: rec['mode'] }
    if (typeof rec['exitDelaySec'] === 'number') entry.exitDelaySec = rec['exitDelaySec']
    if (typeof rec['entryDelaySec'] === 'number') entry.entryDelaySec = rec['entryDelaySec']
    if (typeof rec['triggeredDurationSec'] === 'number') {
      entry.triggeredDurationSec = rec['triggeredDurationSec']
    }
    if (typeof rec['postTriggeredAction'] === 'string') {
      entry.postTriggeredAction = rec['postTriggeredAction']
    }
    if (rec['schedule'] !== undefined) entry.schedule = rec['schedule']
    if (typeof rec['notifyDuringEntryDelay'] === 'boolean') {
      entry.notifyDuringEntryDelay = rec['notifyDuringEntryDelay']
    }
    if (typeof rec['notifySensorRewatched'] === 'boolean') {
      entry.notifySensorRewatched = rec['notifySensorRewatched']
    }
    if (typeof rec['notifySensorIgnored'] === 'boolean') {
      entry.notifySensorIgnored = rec['notifySensorIgnored']
    }
    modeDelaysLoose.push(entry)
  }
  const truncatedTriggered = Math.max(0, Math.min(3600, Math.trunc(triggered)))
  const rawAction = raw['postTriggeredAction']
  const postTriggeredAction =
    rawAction === 'rearmAfter' || rawAction === 'disableAfter' || rawAction === 'doNothing'
      ? rawAction
      : undefined
  return {
    exitDelaySec: Math.max(0, Math.min(600, Math.trunc(exit))),
    entryDelaySec: Math.max(0, Math.min(600, Math.trunc(entry))),
    triggeredDurationSec: truncatedTriggered,
    ...(postTriggeredAction !== undefined ? { postTriggeredAction } : {}),
    announceTargets,
    nonBlocking: lists('nonBlocking'),
    blocking: lists('blocking'),
    secureOnArmOff: lists('secureOnArmOff'),
    modeDelays: modeDelaysFromPersisted(modeDelaysLoose).entries,
  }
}

function settingsToPersisted(settings: NcAlarmSettings): PersistedProfileSettings {
  return {
    exitDelaySec: settings.exitDelaySec,
    entryDelaySec: settings.entryDelaySec,
    triggeredDurationSec: settings.triggeredDurationSec,
    ...(settings.postTriggeredAction !== undefined
      ? { postTriggeredAction: settings.postTriggeredAction }
      : {}),
    announceTargets: [...settings.announceTargets],
    nonBlocking: settings.nonBlocking.map((l) => ({
      mode: l.mode,
      deviceIds: [...l.deviceIds],
    })),
    blocking: settings.blocking.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
    secureOnArmOff: settings.secureOnArmOff.map((l) => ({
      mode: l.mode,
      deviceIds: [...l.deviceIds],
    })),
    modeDelays: settings.modeDelays.map((e) => ({ ...e })),
  }
}

function profilesStateFromPersisted(
  activeId: string,
  rows: readonly PersistedProfileRow[],
  current: NcAlarmSettings,
): NcAlarmProfilesState {
  const profiles = rows
    .filter((r) => r.id.length > 0 && r.name.trim().length > 0)
    .map((r) => ({
      id: r.id,
      name: r.name,
      settings: settingsBlobFromPersisted(r.settings),
    }))
  return ensureAlarmProfiles(profiles.length > 0 ? { activeId, profiles } : null, current)
}

function profilesToPersisted(state: NcAlarmProfilesState): {
  readonly activeProfileId: string
  readonly profiles: PersistedProfileRow[]
} {
  return {
    activeProfileId: state.activeId,
    profiles: state.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      settings: settingsToPersisted(p.settings),
    })),
  }
}

function profilesViewOf(state: NcAlarmProfilesState): NcAlarmProfilesView {
  return {
    activeId: state.activeId,
    items: state.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      isDefault: isDefaultAlarmProfileId(p.id),
    })),
  }
}

/**
 * What the panel reports after EVERY publish.
 *
 * A direct call, not an event: the Notification Center and the panel are in the
 * same process, and an alarm notification that could be dropped as telemetry
 * (D8) would be an assurance the operator sometimes does not get — which is
 * indistinguishable from the alarm not having gone off.
 *
 * Two consumers, one hook, deliberately:
 *
 *  - `state` lands on every publish and refreshes the `deviceState` gate's
 *    cache SYNCHRONOUSLY. The 30-second reload tick used to be the only writer,
 *    so a rule gated on `armed_away` could keep firing for up to half a minute
 *    after a disarm — the gate answered a state the panel had already left.
 *    The tick stays, as reconciliation.
 *  - `transition` is set only on the publishes worth notifying about
 *    ({@link alarmTransition}), and it is null on all the others.
 */
export interface NcAlarmPublishReport {
  readonly state: AlarmState
  /**
   * The mode the machine belongs to — what `pending`/`triggered` will settle
   * back into. It is what lets a rule gated on `armed_away` keep matching the
   * away mode's own entry delay and siren, and nothing else's (D630).
   */
  readonly target: AlarmMachine['target']
  readonly transition: NcAlarmTransition | null
}

export type NcAlarmPublishHook = (report: NcAlarmPublishReport) => void

/**
 * What the panel has to ask somebody else before it can arm.
 *
 * The panel owns the STATE MACHINE and nothing else: which devices a mode
 * covers is a function of the rule set, and the rule set lives in the
 * Notification Center. So the panel asks, and the centre answers with the
 * covered openings that read open right now — never with a list the panel
 * keeps, which would be the second authority D62 exists to prevent.
 *
 * `announceRefusal` and `announceCheckFailed` are the other half. Both have to
 * reach the operator's PHONE, not only the caller of the cap: the arm is often
 * a notification button press, and "the mutation failed" is not something a
 * phone renders. The centre owns the outbox, so it does the saying; the panel
 * only reports the fact.
 */
export interface NcAlarmArmGuardHook {
  /**
   * The covered devices of this mode that read OPEN now, and the covered ones
   * that could not be read. Throws only when NOTHING could be read — the panel
   * then arms and says so.
   */
  openings(mode: AlarmArmMode): Promise<NcAlarmOpenings>
  /**
   * Fire-and-forget close / lock / off for controllable openings that should
   * secure on this arm. Never throws; never awaited by the panel.
   */
  secureOnArm(devices: readonly NcAlarmOpenDevice[]): void
  /** Tell the operator the arm was refused, and why. Never throws. */
  announceRefusal(input: {
    readonly refusal: NcAlarmRefusal
    readonly blocking: readonly NcAlarmOpenDevice[]
    readonly state: AlarmState
    readonly at: number
  }): void
  /** Tell the operator the arm went ahead WITHOUT the openings check. Never throws. */
  announceCheckFailed(input: {
    readonly mode: AlarmArmMode
    /** The state the arm lands in (`arming` or `armed_<mode>`). */
    readonly state: AlarmState
    readonly at: number
    readonly error: string
  }): void
}

/**
 * The log line for a trigger the state machine ignored, per state. `trigger`
 * ignores four: disarmed, arming (the exit delay), and pending / triggered
 * (already counting down or going off — a second sensor must not restart it).
 */
function ignoredTriggerMessage(state: AlarmState): string {
  if (state === 'arming') return 'alarm trigger ignored — the panel is still arming (exit delay)'
  if (state === 'pending') return 'alarm trigger ignored — the entry delay is already running'
  if (state === 'triggered') return 'alarm trigger ignored — the alarm is already going off'
  if (state === 'disarmed') return 'alarm trigger ignored — the panel is disarmed'
  // Not reachable today (`trigger` accepts every armed word); the `state` meta
  // names it if that ever changes.
  return 'alarm trigger ignored — the panel cannot be triggered in this state'
}

/** `armed_home` and friends — the only targets a machine may settle into. */
function isArmTarget(value: unknown): value is AlarmMachine['target'] {
  return value === 'disarmed' || (typeof value === 'string' && value.startsWith('armed_'))
}

function optionalInstant(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Rebuild the machine from the persisted blob, or null when there is nothing
 * trustworthy in it.
 *
 * A type GUARD, not a cast: the blob has survived a schema change once already
 * (`clearAt` did not exist), and the failure mode of a cast here is an alarm
 * that reports a state it cannot reach. Anything unrecognised falls back to
 * DISARMED, which is the state an operator will notice.
 *
 * Exported for the test that proves a pre-`clearAt` blob still restores.
 */
function machineFromPersisted(raw: unknown): AlarmMachine | null {
  if (raw === null || typeof raw !== 'object') return null
  const rec: Record<string, unknown> = { ...raw }
  if (!isArmTarget(rec['target']) || typeof rec['changedAt'] !== 'number') return null
  const armedAt = optionalInstant(rec['armedAt'])
  const triggerAt = optionalInstant(rec['triggerAt'])
  const clearAt = optionalInstant(rec['clearAt'])
  const clearToDisarmed = rec['clearToDisarmed'] === true
  return {
    target: rec['target'],
    ...(armedAt !== undefined ? { armedAt } : {}),
    ...(triggerAt !== undefined ? { triggerAt } : {}),
    ...(clearAt !== undefined ? { clearAt } : {}),
    ...(clearToDisarmed ? { clearToDisarmed: true } : {}),
    fired: rec['fired'] === true,
    changedAt: rec['changedAt'],
  }
}

export class NcAlarmPanelDevice extends BaseDevice<typeof ncAlarmPanelSchema> {
  readonly features: readonly DeviceFeature[] = []

  private machine: AlarmMachine = DISARMED
  private ticker: ReturnType<typeof setInterval> | null = null
  private onPublish: NcAlarmPublishHook | null = null
  /**
   * The state the last publish reported. Null until the first one, so the
   * BOOT publish never announces: a hub restarting while armed would otherwise
   * announce "Away armed" on every deploy.
   */
  private lastPublished: AlarmState | null = null
  /** WHO the current countdown belongs to — see {@link NcAlarmAttribution}. */
  private readonly attribution = new NcAlarmAttribution()
  /** Sensors this arm is ignoring — see {@link NcAlarmExclusions}. */
  private readonly exclusions = new NcAlarmExclusions()
  /** The inputs this arm session ignores — see {@link NcAlarmInputBypasses}. */
  private readonly bypasses = new NcAlarmInputBypasses()
  /** Who answers "is anything open" — null until the centre wires itself in. */
  private armGuard: NcAlarmArmGuardHook | null = null
  /**
   * The LATEST refusal — the only one whose Arm anyway can still arm.
   *
   * In RAM and only in RAM, deliberately: it is a confirmation of something the
   * operator read minutes ago, and a confirmation that survived a restart would
   * let a process respawn arm the alarm around an open window nobody re-read.
   * Losing it costs one extra tap. Nothing else clears it: a disarm or an arm
   * moves `machine.changedAt`, and `armAnyway` then finds it stale.
   */
  private refusal: NcAlarmRefusal | null = null
  /** The refusal whose Arm anyway was pressed last — a second press is `used`. */
  private spentRefusalId: string | null = null
  /** Makes refusal ids unique inside one millisecond. */
  private refusalSeq = 0

  constructor(ctx: DeviceContext) {
    // The class IS an alarm panel — never read the type from the loaded meta:
    // a boot that failed to read it (slow store, contended init) used to hand
    // down the kernel's placeholder, and `register` persisted the wrong type
    // back, after which every boot re-read it (the panel showed up as a camera
    // in the viewer, 2026-08-15).
    super(ctx, ncAlarmPanelSchema, { type: DeviceType.AlarmPanel })
    this.logDroppedModeDelays()
    this.restore()
    this.migrateStockAfterTriggerDefaults()
    this.registerAlarmCap()
    this.publish()
    if (this.config.get('announceArm') === false && this.config.get('announceTargets').length > 0) {
      // Vestigial: announceArm no longer gates anything (D630).
      this.ctx.logger.info(
        'alarm announcements now cover every transition (D630) — the announceArm switch is gone',
        { tags: { deviceId: this.id } },
      )
    }
    // Panel recipients are retired: notifications go only through alarm rules.
    // Clear a leftover list so prune / a dual path cannot revive.
    if (this.config.get('announceTargets').length > 0) {
      this.ctx.logger.info('alarm announceTargets cleared — deliver via alarm rules only', {
        tags: { deviceId: this.id },
        meta: { cleared: this.config.get('announceTargets').length },
      })
      void this.config.set('announceTargets', [])
    }
  }

  /**
   * One-shot: the pre-D701 stock seed was `triggeredDurationSec: 0` + absent /
   * `doNothing` (stay triggered forever). That left After trigger looking dead
   * in the UI. Flip only that seed to {@link DEFAULT_DELAYS} — never a custom
   * duration or an explicit `disableAfter`.
   */
  private migrateStockAfterTriggerDefaults(): void {
    const duration = this.config.get('triggeredDurationSec')
    const action = this.config.get('postTriggeredAction')
    const stockStay = duration === 0 && (action === undefined || action === 'doNothing')
    if (!stockStay) return
    void this.config.set('triggeredDurationSec', DEFAULT_DELAYS.triggeredDurationSec)
    void this.config.set('postTriggeredAction', DEFAULT_DELAYS.postTriggeredAction)
    this.ctx.logger.info('alarm after-trigger defaults migrated to the stock re-arm', {
      tags: { deviceId: this.id },
      meta: {
        fromDurationSec: duration,
        fromAction: action ?? 'absent',
        toDurationSec: DEFAULT_DELAYS.triggeredDurationSec,
        toAction: DEFAULT_DELAYS.postTriggeredAction,
      },
    })
  }

  /** The operator-visible configuration, as the cap serves it. */
  settings(): NcAlarmSettings {
    const storedAction = this.config.get('postTriggeredAction')
    return {
      exitDelaySec: this.config.get('exitDelaySec'),
      entryDelaySec: this.config.get('entryDelaySec'),
      triggeredDurationSec: this.config.get('triggeredDurationSec'),
      // Only the STORED action — never a derivation. Inheritance derives from
      // the resolved duration when both global and mode leave the action unset.
      ...(storedAction !== undefined ? { postTriggeredAction: storedAction } : {}),
      announceArm: this.config.get('announceArm'),
      announceTargets: [...this.config.get('announceTargets')],
      nonBlocking: modeDeviceListFromPersisted(this.config.get('nonBlocking')),
      blocking: modeDeviceListFromPersisted(this.config.get('blocking')),
      secureOnArmOff: modeDeviceListFromPersisted(this.config.get('secureOnArmOff')),
      modeDelays: modeDelaysFromPersisted(this.config.get('modeDelays')).entries,
    }
  }

  /**
   * Apply an editor's patch and return what the panel settled on.
   *
   * The new delays take effect on the NEXT transition, never retroactively: a
   * machine already counting down keeps the instants it was given (the exit
   * delay is read at arm, the entry delay and siren duration at trigger, and
   * the machine stores the instants, not the durations). Re-deriving `armedAt`
   * from a delay the operator changed mid-exit would move the arm instant under
   * somebody who is walking out of the door.
   *
   * Two phases, so a refused patch writes NOTHING:
   *  1. every refusal is checked first (a mode this panel does not offer, an
   *     add to a full non-blocking list) — it logs why and throws;
   *  2. every LIST write is CALLED before the first `await`. `DeviceConfig.set`
   *     replaces its in-memory value synchronously, so a list computed after an
   *     await could be based on a list another call has since replaced — and a
   *     whole-list write (the deleted-device prune sends one, computed
   *     synchronously before calling: `device-prune-runner.ts` `applyAlarm`)
   *     would erase the membership edit that landed in between.
   */
  async applySettings(patch: NcAlarmSettingsPatch): Promise<NcAlarmSettings> {
    const edits = patch.modeDelays ?? []
    const membership = patch.nonBlockingEdit
    const blockingEdit = patch.blockingEdit
    const secureEdit = patch.secureOnArmEdit
    // Phase 1 — check, write nothing.
    for (const edit of edits) this.refuseUnofferedMode(edit.mode)
    if (membership !== undefined) {
      this.refuseUnofferedMode(membership.mode, membership.deviceId)
      const base =
        patch.nonBlocking !== undefined
          ? patch.nonBlocking
          : modeDeviceListFromPersisted(this.config.get('nonBlocking'))
      const verdict = applyNonBlockingEdit(base, membership)
      if (verdict.kind === 'refused') {
        this.ctx.logger.info('alarm settings refused', {
          tags: { deviceId: membership.deviceId },
          meta: { panelId: this.id, reason: 'list-full', mode: verdict.mode, list: 'nonBlocking' },
        })
        throw new Error(
          `the ${verdict.mode} non-blocking list already holds ${verdict.max} devices — remove one first`,
        )
      }
    }
    if (blockingEdit !== undefined) {
      this.refuseUnofferedMode(blockingEdit.mode, blockingEdit.deviceId)
      const base =
        patch.blocking !== undefined
          ? patch.blocking
          : modeDeviceListFromPersisted(this.config.get('blocking'))
      const verdict = applyBlockingEdit(base, blockingEdit)
      if (verdict.kind === 'refused') {
        this.ctx.logger.info('alarm settings refused', {
          tags: { deviceId: blockingEdit.deviceId },
          meta: { panelId: this.id, reason: 'list-full', mode: verdict.mode, list: 'blocking' },
        })
        throw new Error(
          `the ${verdict.mode} blocking list already holds ${verdict.max} devices — remove one first`,
        )
      }
    }
    if (secureEdit !== undefined) {
      this.refuseUnofferedMode(secureEdit.mode, secureEdit.deviceId)
      const base =
        patch.secureOnArmOff !== undefined
          ? patch.secureOnArmOff
          : modeDeviceListFromPersisted(this.config.get('secureOnArmOff'))
      const verdict = applySecureOnArmEdit(base, secureEdit)
      if (verdict.kind === 'refused') {
        this.ctx.logger.info('alarm settings refused', {
          tags: { deviceId: secureEdit.deviceId },
          meta: {
            panelId: this.id,
            reason: 'list-full',
            mode: verdict.mode,
            list: 'secureOnArmOff',
          },
        })
        throw new Error(
          `the ${verdict.mode} secure-on-arm-off list already holds ${verdict.max} devices — remove one first`,
        )
      }
    }
    // Phase 2 — every list write is CALLED here, synchronously; none awaited yet.
    const listWrites: Promise<void>[] = []
    if (patch.nonBlocking !== undefined) {
      listWrites.push(
        this.config.set(
          'nonBlocking',
          patch.nonBlocking.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
        ),
      )
    }
    if (patch.blocking !== undefined) {
      listWrites.push(
        this.config.set(
          'blocking',
          patch.blocking.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
        ),
      )
    }
    if (patch.secureOnArmOff !== undefined) {
      listWrites.push(
        this.config.set(
          'secureOnArmOff',
          patch.secureOnArmOff.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
        ),
      )
    }
    let membershipChanged: boolean | null = null
    if (membership !== undefined) {
      // Computed from the value AFTER the whole-list write above (already replaced in memory).
      const result = applyNonBlockingEdit(
        modeDeviceListFromPersisted(this.config.get('nonBlocking')),
        membership,
      )
      if (result.kind === 'applied') {
        membershipChanged = result.changed
        if (result.changed) {
          listWrites.push(
            this.config.set(
              'nonBlocking',
              result.lists.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
            ),
          )
        }
      }
    }
    if (blockingEdit !== undefined) {
      const result = applyBlockingEdit(
        modeDeviceListFromPersisted(this.config.get('blocking')),
        blockingEdit,
      )
      if (result.kind === 'applied' && result.changed) {
        membershipChanged = true
        listWrites.push(
          this.config.set(
            'blocking',
            result.lists.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
          ),
        )
      }
    }
    if (secureEdit !== undefined) {
      const result = applySecureOnArmEdit(
        modeDeviceListFromPersisted(this.config.get('secureOnArmOff')),
        secureEdit,
      )
      if (result.kind === 'applied' && result.changed) {
        membershipChanged = true
        listWrites.push(
          this.config.set(
            'secureOnArmOff',
            result.lists.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
          ),
        )
      }
    }
    const persistedDelays = modeDelaysFromPersisted(this.config.get('modeDelays'))
    const beforeDelays = persistedDelays.entries
    const afterDelays = edits.length > 0 ? applyModeDelaysEdits(beforeDelays, edits) : beforeDelays
    if (edits.length > 0) {
      // An entry of a mode this release does not know is written back as it was; a duplicate or
      // an out-of-bounds field is corrupt and goes, one line each (D391).
      for (const drop of persistedDelays.dropped) {
        if (drop.why === 'unknown-mode') continue
        this.ctx.logger.info('alarm per-mode delay discarded on write', {
          tags: { deviceId: this.id },
          meta: { mode: drop.mode, why: drop.why, field: drop.field },
        })
      }
      listWrites.push(this.config.set('modeDelays', [...afterDelays, ...persistedDelays.foreign]))
    }
    await Promise.all(listWrites)
    this.logModeDelayChanges(beforeDelays, afterDelays, edits)
    // Phase 3 — the scalars. Field by field, not a loop over `Object.entries`: a
    // dynamic key would need a cast to satisfy the config's key type, and the
    // whole value of the typed config is that an unknown field cannot be written
    // by accident.
    if (patch.exitDelaySec !== undefined) await this.config.set('exitDelaySec', patch.exitDelaySec)
    if (patch.entryDelaySec !== undefined) {
      await this.config.set('entryDelaySec', patch.entryDelaySec)
    }
    if (patch.triggeredDurationSec !== undefined) {
      await this.config.set('triggeredDurationSec', patch.triggeredDurationSec)
    }
    if (patch.postTriggeredAction !== undefined) {
      await this.config.set('postTriggeredAction', patch.postTriggeredAction)
    }
    if (patch.announceArm !== undefined) await this.config.set('announceArm', patch.announceArm)
    if (patch.announceTargets !== undefined) {
      await this.config.set('announceTargets', [...patch.announceTargets])
    }
    if (membership !== undefined && membershipChanged !== null) {
      this.ctx.logger.info('alarm non-blocking list changed', {
        tags: { deviceId: membership.deviceId },
        meta: {
          panelId: this.id,
          mode: membership.mode,
          nonBlocking: membership.nonBlocking,
          changed: membershipChanged,
        },
      })
    }
    const settled = this.settings()
    await this.persistProfilesState(
      syncActiveAlarmProfileSettings(this.readProfilesState(), settled),
    )
    return settled
  }

  /** Named profiles + which one is active — for {@link NcAlarmConfig.profiles}. */
  profilesView(): NcAlarmProfilesView {
    return profilesViewOf(this.readProfilesState())
  }

  /**
   * Create a named profile (system defaults, or clone). Does not activate.
   * `newId` is assigned by the caller (usually `randomUUID`).
   */
  async createProfile(input: {
    readonly name: string
    readonly newId: string
    readonly source: NcAlarmProfileCreateSource
  }): Promise<NcAlarmProfilesView> {
    const result = createAlarmProfilePure(this.readProfilesState(), {
      name: input.name,
      id: input.newId,
      source: input.source,
    })
    if (result.kind === 'refused') throw this.profilesRefuseError(result.reason, result.detail)
    await this.persistProfilesState(result.state)
    this.ctx.logger.info('alarm profile created', {
      tags: { deviceId: this.id },
      meta: {
        profileId: input.newId,
        name: input.name.trim(),
        source: input.source.kind,
      },
    })
    return profilesViewOf(result.state)
  }

  async renameProfile(id: string, name: string): Promise<NcAlarmProfilesView> {
    const result = renameAlarmProfilePure(this.readProfilesState(), { id, name })
    if (result.kind === 'refused') throw this.profilesRefuseError(result.reason, result.detail)
    await this.persistProfilesState(result.state)
    this.ctx.logger.info('alarm profile renamed', {
      tags: { deviceId: this.id },
      meta: { profileId: id, name: name.trim() },
    })
    return profilesViewOf(result.state)
  }

  /**
   * Delete a non-default profile. If it was active, Default becomes active and
   * its settings are applied to the flat keys (arm path).
   */
  async deleteProfile(id: string): Promise<NcAlarmProfilesView> {
    const before = this.readProfilesState()
    const result = deleteAlarmProfilePure(before, id)
    if (result.kind === 'refused') throw this.profilesRefuseError(result.reason, result.detail)
    const switched = before.activeId === id
    await this.persistProfilesState(result.state)
    if (switched) {
      const def = result.state.profiles.find((p) => p.id === NC_ALARM_DEFAULT_PROFILE_ID)
      if (def !== undefined) await this.replaceFlatSettings(def.settings)
    }
    this.ctx.logger.info('alarm profile deleted', {
      tags: { deviceId: this.id },
      meta: { profileId: id, activatedDefault: switched },
    })
    return profilesViewOf(result.state)
  }

  /**
   * Make a profile active and apply its blob onto the flat settings the arm
   * path reads.
   */
  async activateProfile(id: string): Promise<NcAlarmProfilesView> {
    const before = this.readProfilesState()
    // Persist any unsaved edits on the CURRENT active profile before leaving it.
    const synced = syncActiveAlarmProfileSettings(before, this.settings())
    const result = activateAlarmProfilePure(synced, id)
    if (result.kind === 'refused') throw this.profilesRefuseError(result.reason, result.detail)
    const next = result.state.profiles.find((p) => p.id === id)
    if (next === undefined) throw this.profilesRefuseError('not-found', id)
    await this.persistProfilesState(result.state)
    await this.replaceFlatSettings(next.settings)
    this.ctx.logger.info('alarm profile activated', {
      tags: { deviceId: this.id },
      meta: { profileId: id, name: next.name },
    })
    return profilesViewOf(result.state)
  }

  private readProfilesState(): NcAlarmProfilesState {
    return profilesStateFromPersisted(
      this.config.get('activeProfileId'),
      this.config.get('profiles'),
      this.settings(),
    )
  }

  private async persistProfilesState(state: NcAlarmProfilesState): Promise<void> {
    const persisted = profilesToPersisted(state)
    await Promise.all([
      this.config.set('activeProfileId', persisted.activeProfileId),
      this.config.set('profiles', persisted.profiles),
    ])
  }

  /** Write a full settings blob onto the flat keys the arm path reads. */
  private async replaceFlatSettings(settings: NcAlarmSettings): Promise<void> {
    const blob = cloneAlarmSettings(settings)
    await Promise.all([
      this.config.set('exitDelaySec', blob.exitDelaySec),
      this.config.set('entryDelaySec', blob.entryDelaySec),
      this.config.set('triggeredDurationSec', blob.triggeredDurationSec),
      this.config.set('announceTargets', [...blob.announceTargets]),
      this.config.set(
        'nonBlocking',
        blob.nonBlocking.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
      ),
      this.config.set(
        'blocking',
        blob.blocking.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
      ),
      this.config.set(
        'secureOnArmOff',
        blob.secureOnArmOff.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
      ),
      this.config.set(
        'modeDelays',
        blob.modeDelays.map((e) => ({ ...e })),
      ),
    ])
  }

  private profilesRefuseError(reason: string, detail?: string): Error {
    switch (reason) {
      case 'name-empty':
        return new Error('alarm profile name must not be empty')
      case 'name-taken':
        return new Error(`an alarm profile named '${detail ?? ''}' already exists`)
      case 'cannot-delete-default':
        return new Error('the Default alarm profile cannot be deleted')
      case 'clone-source-missing':
        return new Error(`alarm profile '${detail ?? ''}' was not found to clone`)
      case 'not-found':
        return new Error(`alarm profile '${detail ?? ''}' was not found`)
      default:
        return new Error(`alarm profile operation refused (${reason})`)
    }
  }

  /**
   * Refuse a mode this panel does not offer — logged by reason, then thrown. A membership edit
   * passes its SENSOR as `deviceId` (the tag); a per-mode delay edit defaults to the panel.
   */
  private refuseUnofferedMode(mode: AlarmArmMode, deviceId: number = this.id): void {
    if (NC_ALARM_MODES.includes(mode)) return
    this.ctx.logger.info('alarm settings refused', {
      tags: { deviceId },
      meta: { panelId: this.id, reason: 'mode-not-offered', mode },
    })
    throw new Error(`alarm mode '${mode}' is not offered by this panel`)
  }

  /** One INFO line per mode-delay field an edit really changed (`null` = inherit). */
  private logModeDelayChanges(
    before: readonly NcAlarmModeDelays[],
    after: readonly NcAlarmModeDelays[],
    edits: readonly NcAlarmModeDelaysEdit[],
  ): void {
    for (const edit of edits) {
      const was = before.find((e) => e.mode === edit.mode)
      const now = after.find((e) => e.mode === edit.mode)
      for (const field of NC_ALARM_DELAY_FIELDS) {
        const from = was?.[field] ?? null
        const to = now?.[field] ?? null
        if (from === to) continue
        this.ctx.logger.info('alarm mode delays changed', {
          tags: { deviceId: this.id },
          meta: { mode: edit.mode, field, from, to },
        })
      }
      if (edit.postTriggeredAction !== undefined) {
        const from = was?.postTriggeredAction ?? null
        const to = now?.postTriggeredAction ?? null
        if (from !== to) {
          this.ctx.logger.info('alarm mode delays changed', {
            tags: { deviceId: this.id },
            meta: { mode: edit.mode, field: 'postTriggeredAction', from, to },
          })
        }
      }
      for (const field of NC_ALARM_NOTIFY_FIELDS) {
        if (edit[field] === undefined) continue
        const from = was?.[field] ?? null
        const to = now?.[field] ?? null
        if (from === to) continue
        this.ctx.logger.info('alarm mode notification switch changed', {
          tags: { deviceId: this.id },
          meta: { mode: edit.mode, field, from, to },
        })
      }
      if (edit.schedule !== undefined) {
        const from = was?.schedule === undefined ? null : 'set'
        const to = now?.schedule === undefined ? null : 'set'
        if (from !== to || edit.schedule !== null) {
          this.ctx.logger.info('alarm mode activation schedule changed', {
            tags: { deviceId: this.id },
            meta: {
              mode: edit.mode,
              cleared: edit.schedule === null,
              windows: now?.schedule?.windows.length ?? 0,
            },
          })
        }
      }
    }
  }

  /** One INFO line per persisted per-mode delay entry the guard refused to trust. */
  private logDroppedModeDelays(): void {
    for (const drop of modeDelaysFromPersisted(this.config.get('modeDelays')).dropped) {
      this.ctx.logger.info('alarm per-mode delay dropped at boot', {
        tags: { deviceId: this.id },
        meta: { mode: drop.mode, why: drop.why, field: drop.field },
      })
    }
  }

  /** Wire the state mirror and the transition notifications. See
   *  {@link NcAlarmPublishHook}. */
  setPublishHook(hook: NcAlarmPublishHook | null): void {
    this.onPublish = hook
  }

  /**
   * A RULE pressed the panel, and says which match it was — in the call itself.
   *
   * The join between a rule's notification and the alarm's. `alarm-panel.trigger`
   * takes nothing but a device id — by design, since a Home Assistant panel
   * provides the same cap — so a rule press on THIS panel never goes through the
   * cap: the notification centre calls this method, in-process and
   * synchronously, with the match that pressed it. The source is never parked
   * anywhere for a later call to pick up: a single "next trigger is this rule's"
   * slot, written before an awaited cap call and read when it landed, was
   * overwritten by a second match 1 ms later, and the press that found it empty
   * skipped the exclusion check and sounded the siren off an excluded contact
   * (2026-10-07 02:32Z, D735).
   *
   * The FIRST accepted press claims the source and owns the countdown; a rule
   * pressing again while the entry delay runs is refused as a trigger and its
   * source becomes a FOLLOWER of the same incident (D705) — the triggered
   * notification tiles the source and every follower as one mosaic.
   */
  triggerFromRule(source: NcAlarmTriggerSource, now: number = Date.now()): NcAlarmPressOutcome {
    return this.press(source, now)
  }

  /**
   * Where the alarm stands for ONE rule match, read BEFORE that match presses the panel
   * (D706) — so the rule's own push can follow the operator's policy in the same evaluation
   * that presses it. The SAME reads the `trigger` method makes, in the same order: an excluded
   * sensor is ignored, a running countdown or a triggered alarm refuses the press, an armed
   * panel starts the countdown (or fires at once when the mode's entry delay is 0).
   *
   * The subject that STARTED the countdown is still its starter on its later matches (a
   * person who stays in view is not "another intrusion during the delay"). A rule press
   * lands synchronously ({@link triggerFromRule}), so the machine this reads already holds
   * every earlier press of the same evaluation — there is no press "in flight" to guess at.
   *
   * A match of a sensor the current arm EXCLUDES is `excluded`: its press will be ignored,
   * and the rule's own push is not sent either (D735) — the panel's bypass logic speaks for it.
   */
  classifyRuleMatch(ref: NcAlarmTriggerSource, now: number = Date.now()): NcAlarmMatchPhase {
    if (this.exclusions.blocks(intrusionDeviceOf(ref))) {
      return { kind: 'excluded', sensorDeviceId: intrusionDeviceOf(ref) }
    }
    if (this.bypasses.blocks(ref.ruleId, intrusionDeviceOf(ref))) {
      return { kind: 'bypassed', ruleId: ref.ruleId, sensorDeviceId: intrusionDeviceOf(ref) }
    }
    const mode = armModeOf(this.machine.target, NC_ALARM_MODES)
    if (mode === null) return { kind: 'none' }
    const state = stateAt(this.machine, now)
    if (state === 'triggered') return { kind: 'triggered', mode }
    const key = subjectKeyOf(ref)
    if (state === 'pending') {
      const starter = this.attribution.current()
      if (starter !== null && subjectKeyOf(starter) === key) {
        return { kind: 'starts-entry-delay', mode }
      }
      return {
        kind: 'entry-delay',
        mode,
        notify: this.notifyPolicy(mode).notifyDuringEntryDelay,
      }
    }
    if (!isArmed(this.machine, now)) return { kind: 'none' }
    const immediate = this.delaysFor(mode).entryDelaySec === 0
    return immediate ? { kind: 'triggers-now', mode } : { kind: 'starts-entry-delay', mode }
  }

  /** The mode's notification switches (D706), read NOW — never cached. */
  notifyPolicy(mode: AlarmArmMode): NcAlarmModeNotifyPolicy {
    return resolveModeNotifyPolicy(
      { modeDelays: modeDelaysFromPersisted(this.config.get('modeDelays')).entries },
      mode,
    )
  }

  /** Current lifecycle word — what the `deviceState` gate compares against. */
  currentState(now: number = Date.now()): AlarmPanelStatus['state'] {
    return stateAt(this.machine, now)
  }

  /** The mode the machine belongs to — see {@link NcAlarmPublishReport.target}. */
  currentTarget(): AlarmMachine['target'] {
    return this.machine.target
  }

  /** Wire the openings check and the refusal / check-failed announcements. */
  setArmGuard(hook: NcAlarmArmGuardHook | null): void {
    this.armGuard = hook
  }

  /**
   * A plain arm. Refused on any open covered device the mode does not tolerate
   * — pressed once or ten times, the answer is the same; the only way past a
   * refusal is {@link armAnyway} with that refusal's id.
   *
   * When the openings could not be read at all it arms (fail-open, announced
   * as a check failure) and EXCLUDES NOTHING NEW: the previous exclusions are
   * left as they were, since there is no reading to replace them with. An
   * `unknown` device neither blocks nor is excluded — nobody was shown it.
   */
  async armWith(mode: AlarmArmMode): Promise<NcAlarmArmOutcome> {
    const now = Date.now()
    if (!this.modeScheduleAllows(mode, now)) {
      this.ctx.logger.info('alarm arm refused — outside activation schedule', {
        tags: { deviceId: this.id },
        meta: { mode },
      })
      return { outcome: 'outside-schedule' }
    }
    const read = await this.applyArmGuard(mode)
    if (read.kind === 'unguarded') return this.settleArm(mode, null, now)
    if (read.kind === 'check-failed') {
      const outcome = this.settleArm(mode, null, now)
      this.announceUncheckedArm(mode, read.error, now)
      return outcome
    }
    if (read.verdict.kind === 'refused') return this.refuse(mode, read.verdict.blocking, now)
    return this.settleArm(
      mode,
      read.verdict.excluded.map((device) => ({
        device,
        why: this.exclusionWhyFor(mode, device),
      })),
      now,
    )
  }

  /** Absent schedule = always allowed (`isScheduleActive`). */
  private modeScheduleAllows(mode: AlarmArmMode, now: number): boolean {
    const schedule = modeDelaysFromPersisted(this.config.get('modeDelays')).entries.find(
      (e) => e.mode === mode,
    )?.schedule
    return isScheduleActive(schedule, now)
  }

  /**
   * The Arm anyway on ONE refusal's notification — the only path that arms
   * around a device that blocks.
   *
   *  1. no held refusal, or a different one (a later refusal replaced it) ⇒
   *     `unknown-refusal`; the id of the refusal spent last ⇒ `used`;
   *  2. the panel changed state since ⇒ `stale`, and the refusal is dropped;
   *  3. older than {@link ARM_ANYWAY_TTL_MS} ⇒ `expired`, and it is dropped;
   *  4. otherwise the openings are READ AGAIN. A device that opened since is a
   *     NEW refusal (new id, new notification) listing EVERY device that
   *     blocks now — the still-open confirmed ones too, so its own Arm anyway
   *     can arm around all of them, and the confirmed ones the re-read reads
   *     UNKNOWN (so that Arm anyway still excludes them). Otherwise the arm excludes what is open
   *     now; a refused device that closed meanwhile is armed normally. A
   *     confirmed device the re-read cannot vouch for — the read failed, or
   *     it reads unknown — stays EXCLUDED (D49: unknown is never secure).
   *  5. the refusal is spent on every outcome of step 4.
   */
  async armAnyway(refusalId: string): Promise<NcAlarmArmOutcome> {
    const now = Date.now()
    const held = this.refusal
    if (held === null || held.id !== refusalId) {
      const reason = refusalId === this.spentRefusalId ? 'used' : 'unknown-refusal'
      return this.rejectArmAnyway(refusalId, reason)
    }
    if (!this.modeScheduleAllows(held.mode, now)) {
      this.refusal = null
      this.ctx.logger.info('alarm arm-anyway refused — outside activation schedule', {
        tags: { deviceId: this.id },
        meta: { mode: held.mode, refusalId },
      })
      return { outcome: 'outside-schedule' }
    }
    if (this.machine.changedAt !== held.panelChangedAt) {
      this.refusal = null
      return this.rejectArmAnyway(refusalId, 'stale')
    }
    if (now - held.at > ARM_ANYWAY_TTL_MS) {
      this.refusal = null
      return this.rejectArmAnyway(refusalId, 'expired')
    }
    // Spent BEFORE the read, so a second press racing this one is `used`.
    this.refusal = null
    this.spentRefusalId = held.id
    const read = await this.applyArmGuard(held.mode, held.blockingIds)
    // The read is async: a disarm or an arm that landed meanwhile wins.
    if (this.machine.changedAt !== held.panelChangedAt) {
      return this.rejectArmAnyway(refusalId, 'stale')
    }
    if (read.kind !== 'read') {
      const outcome = this.settleArm(
        held.mode,
        held.blocking.map((device) => ({ device, why: 'arm-anyway-unverified' })),
        now,
      )
      if (read.kind === 'check-failed') this.announceUncheckedArm(held.mode, read.error, now)
      return outcome
    }
    const tolerated = this.nonBlockingFor(held.mode)
    const forceBlock = this.blockingFor(held.mode)
    const unknown = new Set(read.openings.unknown)
    if (read.verdict.kind === 'refused') {
      // Every device that blocks NOW, as a plain arm would see it…
      const plain = decideArm({
        mode: held.mode,
        open: read.openings.open,
        nonBlocking: tolerated,
        blocking: forceBlock,
      })
      const blockingNow = plain.kind === 'refused' ? plain.blocking : read.verdict.blocking
      // …plus every device the operator already confirmed that the re-read
      // cannot vouch for (D49: unknown is never secure). Left out, the next
      // Arm anyway would arm it LIVE — a device the operator was shown open,
      // armed on a guess — which the success path below never does.
      const shownIds = new Set(blockingNow.map((d) => d.deviceId))
      const blocking = [
        ...blockingNow,
        ...held.blocking.filter((d) => unknown.has(d.deviceId) && !shownIds.has(d.deviceId)),
      ]
      return this.refuse(held.mode, blocking, now)
    }
    return this.settleArm(
      held.mode,
      [
        ...read.verdict.excluded.map(
          (device): NcArmExclusion => ({
            device,
            why: tolerated.includes(device.deviceId) ? 'non-blocking' : 'arm-anyway',
          }),
        ),
        ...held.blocking
          .filter((device) => unknown.has(device.deviceId))
          .map((device): NcArmExclusion => ({ device, why: 'arm-anyway-unknown' })),
      ],
      now,
    )
  }

  /**
   * Sensors the current arm is ignoring — what the armed/arming sentence names
   * as excluded, and the only place that list is published.
   */
  excludedDevices(): readonly number[] {
    return this.exclusions.list()
  }

  /**
   * The same exclusions, each with its phase — `open` while the device is
   * still open as it was when armed, `closed` once it has been secured and
   * its next open re-arms it. What the live view shows; a read, never a copy.
   */
  exclusionPhases(): readonly NcAlarmExclusionPhase[] {
    return this.exclusions.snapshot().map((e) => ({ deviceId: e.deviceId, phase: e.phase }))
  }

  /**
   * Disarm — the ONE path, for the cap and the `nc.disarmAlarm` bridge alike.
   * The exclusions belong to the ARM, and this one is over: keeping them would
   * carry an open window's exemption into tonight's arm, which nobody
   * confirmed.
   */
  async disarm(): Promise<void> {
    this.machine = disarm(Date.now())
    this.attribution.clear()
    this.exclusions.clear()
    // The bypasses are ended by `publish`, which sees EVERY disarm — this one
    // and the `disableAfter` auto-disarm alike.
    this.publish()
  }

  /**
   * "Bypass this input until disarm" — ONE (rule, input) pair stops pressing
   * the panel for the rest of this arm session.
   *
   * Refused on a disarmed panel (there is no session to bypass in) and for a
   * notification about an arm that is already over (`stale`). It never cancels
   * an entry delay or a siren already running — it stops the NEXT presses of
   * that input; the disarm stays the operator's own button.
   */
  bypassInput(input: NcAlarmInputBypassInput, now: number = Date.now()): NcAlarmInputBypassOutcome {
    const refuse = (reason: NcAlarmInputBypassRefusal): NcAlarmInputBypassOutcome => {
      this.ctx.logger.info('alarm input bypass refused', {
        tags: { deviceId: input.deviceId },
        meta: { panelDeviceId: this.id, ruleId: input.ruleId, rule: input.ruleName, reason },
      })
      return { outcome: 'refused', reason }
    }
    if (this.machine.target === 'disarmed') return refuse('disarmed')
    const sessionAt = this.config.get('armSessionAt')
    if (input.notedAt !== undefined && sessionAt !== undefined && input.notedAt < sessionAt) {
      return refuse('stale')
    }
    const added = this.bypasses.add(input, now)
    if (added === 'full') return refuse('full')
    if (added === 'bypassed') {
      this.persist()
      this.ctx.logger.info('alarm input bypassed until disarm', {
        tags: { deviceId: input.deviceId },
        meta: {
          panelDeviceId: this.id,
          ruleId: input.ruleId,
          rule: input.ruleName,
          cameraId: input.cameraId,
          state: stateAt(this.machine, now),
          bypassed: this.bypasses.size,
        },
      })
    }
    return { outcome: added, bypassed: this.bypasses.snapshot() }
  }

  /** The inputs this arm session ignores — what the live view reports. A read, never a copy. */
  inputBypasses(): readonly NcAlarmInputBypassRecord[] {
    return this.bypasses.snapshot()
  }

  /**
   * Drop the bypasses whose input is no longer an input — the rule was
   * deleted, disabled, or no longer names the device. Called from the centre's
   * rule-reload tick; one line per drop, tagged with the input.
   */
  pruneInputBypasses(keep: (entry: NcAlarmInputBypassRecord) => boolean): void {
    const removed = this.bypasses.prune(keep)
    if (removed.length === 0) return
    this.persist()
    for (const entry of removed) {
      this.ctx.logger.info('alarm input bypass dropped — the rule no longer has this input', {
        tags: { deviceId: entry.deviceId },
        meta: { panelDeviceId: this.id, ruleId: entry.ruleId, rule: entry.ruleName },
      })
    }
  }

  /**
   * One opening's reading (`open` / `secure`, D630's vocabulary — a cover is
   * secure only when `closed`, a lock only when `locked`), from whoever saw
   * it: the sensor's own event, or the centre's reconcile tick.
   *
   * The lift is two-phase (`alarm-exclusions.ts`), so this is safe to call with
   * the same reading repeatedly, and an unreadable state changes nothing. Fed
   * BEFORE the event that carried it is evaluated, so the open that re-arms a
   * sensor is already lifted when the rule it fires reaches the panel.
   */
  observeOpening(
    deviceId: number,
    reading: NcExclusionReading,
    now: number = Date.now(),
    options: NcObserveOpeningOptions = {},
  ): NcObserveOpeningResult {
    const change = this.exclusions.observe(deviceId, reading, now, options.changedAt)
    if (change === 'unchanged') return 'unchanged'
    // BOTH changes persist — a phase kept only in RAM is half a durable
    // exclusion, and a deploy between the close and the re-open would demand a
    // second close before the sensor could rejoin.
    this.persist()
    if (change === 'closed') return 'closed'
    // A sensor rejoining the alarm CHANGES WHAT IS PROTECTED, and the operator
    // has no other way to learn it happened — so it is a line AND a
    // notification to the panel's recipients.
    this.ctx.logger.info('alarm exclusion lifted — the device was secured and opened again', {
      tags: { deviceId },
      meta: { panelDeviceId: this.id, remaining: this.exclusions.list().length },
    })
    // D706: the event that carried this open is about to be evaluated, and its rule may be
    // the one that STARTS the entry delay — whose notification already names this sensor.
    // The caller then announces AFTER that evaluation ({@link announceLifted}).
    if (options.deferLiftAnnouncement !== true) this.announceLifted(deviceId, now)
    return 'lifted'
  }

  /**
   * "Watched again" for a sensor this arm had bypassed (D706) — sent only when the armed
   * mode's `notifySensorRewatched` is on, and never when that same sensor is the one that
   * starts the entry delay (the entry-delay notification is about it already). Either
   * refusal is a line on the sensor, with its reason.
   */
  announceLifted(deviceId: number, now: number = Date.now()): void {
    const mode = armModeOf(this.machine.target, NC_ALARM_MODES)
    const policy = mode !== null ? this.notifyPolicy(mode) : null
    if (policy === null || !policy.notifySensorRewatched) {
      this.ctx.logger.info('alarm "watched again" not notified — the mode does not notify it', {
        tags: { deviceId },
        meta: { panelDeviceId: this.id, mode, reason: 'rewatched-notify-off' },
      })
      return
    }
    if (this.startsEntryDelay(deviceId, now)) {
      this.ctx.logger.info(
        'alarm "watched again" not notified — the same sensor started the entry delay',
        {
          tags: { deviceId },
          meta: { panelDeviceId: this.id, mode, reason: 'starts-entry-delay' },
        },
      )
      return
    }
    this.announceBypass({ deviceId, event: 'lifted' }, now)
  }

  /** Did THIS sensor start the running entry delay? A rule press lands synchronously, so
   *  a press of the evaluation that lifted it has already landed when this is asked. */
  private startsEntryDelay(deviceId: number, now: number): boolean {
    if (stateAt(this.machine, now) !== 'pending') return false
    const starter = this.attribution.current()
    return starter !== null && intrusionDeviceOf(starter) === deviceId
  }

  /**
   * A DELETED device leaves the current arm's exclusions: it can never report
   * the close that would lift it, and the live view would list it forever.
   * Called by the notification centre's deleted-device prune, only after the
   * device manager confirmed the row is gone.
   */
  forgetExcluded(deviceId: number): void {
    if (!this.exclusions.forget(deviceId)) return
    this.persist()
    this.ctx.logger.info('alarm exclusion dropped — the device was deleted', {
      tags: { deviceId },
      meta: { panelDeviceId: this.id, remaining: this.exclusions.list().length },
    })
  }

  /** Stop the countdown when the device goes away. The state itself is
   *  persisted, so nothing is lost — only the announcements stop. */
  stopCountdown(): void {
    this.stopTicking()
  }

  // ── internals ───────────────────────────────────────────────────────

  /**
   * Ask the centre what is open and decide — or say why there is nothing to
   * decide with.
   *
   * Fail-OPEN by construction, in three places, and each one is a decision:
   *
   *  - no guard wired (an agent node, a boot pass before the centre exists) ⇒
   *    `unguarded`, arm. A panel that cannot ask must not refuse.
   *  - the read threw (nothing could be read) ⇒ `check-failed`, arm, and SAY
   *    so — a WARN here and, once the arm has LANDED, `announceCheckFailed` on
   *    the operator's phone. Refusing on a failed read would send the operator
   *    to shut a window that is already shut.
   *  - a covered device whose state is UNKNOWN ⇒ never blocks and is never
   *    counted secure (D49); the guard logs one line each, under its own id.
   *
   * `acknowledged` is what an Arm anyway confirms — the ids its refusal SHOWED.
   */
  private async applyArmGuard(
    mode: AlarmArmMode,
    acknowledged?: readonly number[],
  ): Promise<NcArmGuardRead> {
    const guard = this.armGuard
    if (guard === null) return { kind: 'unguarded' }
    let openings: NcAlarmOpenings
    try {
      openings = await guard.openings(mode)
    } catch (err) {
      this.ctx.logger.warn(
        'alarm arm guard could not read the openings — arming without the check',
        {
          tags: { deviceId: this.id },
          meta: { mode, error: String(err) },
        },
      )
      return { kind: 'check-failed', error: String(err) }
    }
    // An UNKNOWN device is logged once, per device, by the guard that read it
    // (`alarm arm check: device state unreadable`) — it knows WHY (read
    // failed, or a word its cap does not define); a second line here said the
    // same thing with less.
    const verdict = decideArm({
      mode,
      open: openings.open,
      nonBlocking: this.nonBlockingFor(mode),
      blocking: this.blockingFor(mode),
      ...(acknowledged !== undefined ? { acknowledged } : {}),
    })
    // Controllable openings with secure-on-arm: fire-and-forget close/lock/off
    // only when the arm proceeds. A refused arm must not slam shutters. They
    // are tolerated (default) and excluded; the exit delay gives the hardware
    // time to move.
    if (verdict.kind === 'arm') {
      const toSecure = openings.open.filter((d) =>
        alarmDeviceSecureOnArm({
          controllable: d.controllable,
          deviceId: d.deviceId,
          secureOnArmOff: this.secureOnArmOffFor(mode),
        }),
      )
      if (toSecure.length > 0) this.armGuard?.secureOnArm(toSecure)
    }
    return { kind: 'read', openings, verdict }
  }

  /**
   * The operator's copy of "armed WITHOUT the openings check" — called only
   * after {@link settleArm}, with the state the panel is really in now. Never
   * on a path that armed nothing: a stale Arm anyway whose re-read also failed
   * used to push "Armed … without checking" for an arm that never happened.
   */
  private announceUncheckedArm(mode: AlarmArmMode, error: string, now: number): void {
    this.armGuard?.announceCheckFailed({
      mode,
      state: stateAt(this.machine, now),
      at: now,
      error,
    })
  }

  /** This mode's non-blocking ids, from the persisted lists. */
  private nonBlockingFor(mode: AlarmArmMode): readonly number[] {
    return this.modeListIds('nonBlocking', mode)
  }

  /** Controllable openings that force-block when open. */
  private blockingFor(mode: AlarmArmMode): readonly number[] {
    return this.modeListIds('blocking', mode)
  }

  /** Controllable openings that opt out of secure-on-arm. */
  private secureOnArmOffFor(mode: AlarmArmMode): readonly number[] {
    return this.modeListIds('secureOnArmOff', mode)
  }

  private modeListIds(
    key: 'nonBlocking' | 'blocking' | 'secureOnArmOff',
    mode: AlarmArmMode,
  ): readonly number[] {
    return (
      modeDeviceListFromPersisted(this.config.get(key)).find((l) => l.mode === mode)?.deviceIds ??
      []
    )
  }

  /** Why an open device was armed around on a plain (non–Arm-anyway) arm. */
  private exclusionWhyFor(mode: AlarmArmMode, device: NcAlarmOpenDevice): NcArmExclusionWhy {
    if (this.nonBlockingFor(mode).includes(device.deviceId)) return 'non-blocking'
    if (
      alarmDeviceSecureOnArm({
        controllable: device.controllable,
        deviceId: device.deviceId,
        secureOnArmOff: this.secureOnArmOffFor(mode),
      })
    ) {
      return 'secure-on-arm'
    }
    return 'non-blocking'
  }

  /**
   * Arm, with these exclusions.
   *
   * `null` exclusions (no guard, or nothing could be read on a plain arm) arm
   * and leave the exclusions as they were — there is no reading to replace them with.
   */
  private settleArm(
    mode: AlarmArmMode,
    exclusions: readonly NcArmExclusion[] | null,
    now: number,
  ): NcAlarmArmOutcome {
    const excluded = (exclusions ?? []).map((e) => e.device)
    if (exclusions !== null) {
      if (excluded.length > 0) {
        this.exclusions.exclude(
          excluded.map((d) => d.deviceId),
          now,
        )
      } else {
        this.exclusions.clear()
      }
      this.persist()
    }
    const resolved = this.delaysFor(mode)
    // A NEW arm is a new session: a bypass the operator made for the previous
    // one is not carried into an arm nobody confirmed it for.
    this.endInputBypasses('arm')
    void this.config.set('armSessionAt', now)
    this.machine = arm(mode, resolved, now)
    this.ctx.logger.info('alarm delays applied', {
      tags: { deviceId: this.id },
      meta: {
        mode,
        phase: 'arm',
        exitDelaySec: resolved.exitDelaySec,
        source: resolved.source.exitDelaySec,
      },
    })
    // Whatever a previous countdown was about is over. An attribution kept
    // across a re-arm would put last night's photograph on tonight's alarm.
    this.attribution.clear()
    this.publish(now)
    // One line per excluded device, tagged with ITS id: "why did 3243 not
    // fire last night" is asked per device, and a single line listing three
    // ids cannot answer it.
    for (const { device, why } of exclusions ?? []) {
      this.ctx.logger.info('alarm armed with an open device excluded', {
        tags: { deviceId: device.deviceId },
        meta: { panelDeviceId: this.id, mode, name: device.name, state: device.state, why },
      })
    }
    const state = stateAt(this.machine, now)
    return { outcome: state === 'arming' ? 'arming' : 'armed', excluded }
  }

  /**
   * Record the refusal, say it per device, and hand it to the operator's phone.
   *
   * The record REPLACES any earlier one — only the latest refusal's Arm anyway
   * can arm (an older notification's button is superseded).
   */
  private refuse(
    mode: AlarmArmMode,
    blocking: readonly NcAlarmOpenDevice[],
    now: number,
  ): NcAlarmArmOutcome {
    this.refusalSeq += 1
    const refusal: NcAlarmRefusal = {
      id: `refusal:${String(this.id)}:${mode}:${String(now)}:${String(this.refusalSeq)}`,
      mode,
      blockingIds: blocking.map((d) => d.deviceId),
      blocking,
      at: now,
      panelChangedAt: this.machine.changedAt,
    }
    this.refusal = refusal
    for (const d of blocking) {
      this.ctx.logger.warn('alarm arm REFUSED — this device is open', {
        tags: { deviceId: d.deviceId },
        meta: { panelDeviceId: this.id, mode, name: d.name, state: d.state, refusalId: refusal.id },
      })
    }
    // Never inside a try that could swallow it: the announcement is the
    // operator's only copy of this, and the only place its Arm anyway lives.
    this.armGuard?.announceRefusal({
      refusal,
      blocking,
      state: stateAt(this.machine, now),
      at: now,
    })
    return { outcome: 'refused', refusalId: refusal.id, blocking }
  }

  /** A pressed Arm anyway that did nothing — refused work, so it says so. */
  private rejectArmAnyway(refusalId: string, reason: NcAlarmArmAnywayRejection): NcAlarmArmOutcome {
    this.ctx.logger.info('alarm Arm anyway rejected — nothing was armed', {
      tags: { deviceId: this.id },
      meta: { refusalId, reason },
    })
    return { outcome: 'rejected', reason }
  }

  private registerAlarmCap(): void {
    const provider: InferNativeProvider<typeof alarmPanelCapability> = {
      getStatus: async () => this.status(),
      arm: async ({ mode }) => {
        // THE ARM CAN BE REFUSED. `arm` used to be unconditional — every mode
        // was armable, always — and the operator's words for what was missing
        // were "un messaggio di errore quando non può essere armato" [an error message when it cannot be armed]. A mode
        // whose openings are open is refused, and the refusal's notification
        // carries the one Arm anyway that can arm around them (D630).
        const outcome = await this.armWith(mode)
        if (outcome.outcome === 'refused') {
          throw new NcAlarmArmRefusedError({ mode, blocking: outcome.blocking })
        }
      },
      disarm: async () => this.disarm(),
      // A MANUAL or external press: a person in the UI, an API caller, an exporter. It
      // carries no source by construction — a rule press on this panel never comes through
      // here, it is {@link triggerFromRule} with its match in the call.
      trigger: async () => {
        this.press(null, Date.now())
      },
    }
    this.ctx.registerNativeCap(alarmPanelCapability, provider)
  }

  /**
   * THE ENTRY DELAY LIVES OR DIES HERE. The one body every press runs — a rule's
   * ({@link triggerFromRule}, with its source) and a person's (the cap, `null`).
   *
   * It used to set `fired: true` outright, calling itself "a panic button", while
   * the entry-delay transition sat in a method NO caller ever reached — so the
   * panel shipped with `pending` unreachable. The doc comment describing the right
   * design is precisely what made it look implemented.
   *
   * Synchronous, end to end: the source is a parameter, never a slot, so two
   * presses cannot exchange their sources however close together they land.
   */
  private press(source: NcAlarmTriggerSource | null, now: number): NcAlarmPressOutcome {
    // EXCLUDED SENSORS DO NOT SET THE ALARM OFF. Without this, arming with a
    // window open and confirming it would sound the siren `entryDelaySec` later,
    // off the very sensor the operator was told about. The SENSOR is
    // `sourceDeviceId`, or the device itself when the sensor is its own device (an
    // unowned contact carries no `sourceDeviceId`; reading only that field let an
    // excluded unowned contact set the alarm off — found by D706's replay).
    const sensor = source !== null ? intrusionDeviceOf(source) : undefined
    if (sensor !== undefined && this.exclusions.blocks(sensor)) {
      // Did the reading that caused this press really MOVE the sensor (D735)? A re-sync, a
      // recovery from `unavailable` or a duplicate did not, and is never announced.
      const moved = this.exclusions.takeMoved(sensor)
      this.ctx.logger.info('alarm trigger ignored — the sensor was open when the alarm was armed', {
        tags: { deviceId: sensor },
        meta: {
          panelDeviceId: this.id,
          ruleId: source?.ruleId,
          rule: source?.ruleName,
          state: stateAt(this.machine, now),
          moved,
        },
      })
      this.announceIgnoredTrigger(sensor, now, moved)
      return 'ignored-excluded'
    }
    if (source !== null && sensor !== undefined && this.bypasses.blocks(source.ruleId, sensor)) {
      // A BYPASSED input is work DROPPED, so it says so — counted, persisted,
      // one line per press, tagged with the input.
      const dropped = this.bypasses.recordDrop(source.ruleId, sensor)
      this.persist()
      this.ctx.logger.info('alarm trigger dropped — this input is bypassed until disarm', {
        tags: { deviceId: sensor },
        meta: {
          panelDeviceId: this.id,
          ruleId: source.ruleId,
          rule: source.ruleName,
          state: stateAt(this.machine, now),
          dropped,
        },
      })
      return 'ignored-bypassed'
    }
    const armed = armModeOf(this.machine.target, NC_ALARM_MODES)
    const resolved = this.delaysFor(armed)
    const next = trigger(this.machine, resolved, now)
    if (next === this.machine) {
      // A trigger the panel refused is work DROPPED. Silence here reads as "the
      // rule never fired" — and the line says WHY in the state's own words: "not
      // armed" during an entry delay or a siren would be false.
      const state = stateAt(this.machine, now)
      this.ctx.logger.info(ignoredTriggerMessage(state), {
        tags: { deviceId: this.id },
        meta: {
          state,
          ...(source !== null ? { ruleId: source.ruleId, rule: source.ruleName } : {}),
        },
      })
      // …but during the ENTRY DELAY the match that pressed it is another subject
      // of the same incident, and the triggered notification shows it (D705).
      // Never during `triggered`: that notification has already left.
      if (state === 'pending' && source !== null) this.reportFollow(this.attribution.follow(source))
      return 'refused'
    }
    // Claimed on EVERY accepted press, a manual one included (with `null`) — so a
    // manual trigger clears whatever a rule left behind instead of inheriting it.
    this.attribution.claim(source)
    this.machine = next
    this.ctx.logger.info('alarm delays applied', {
      tags: { deviceId: this.id },
      meta: {
        mode: armed,
        phase: 'trigger',
        entryDelaySec: resolved.entryDelaySec,
        triggeredDurationSec: resolved.triggeredDurationSec,
        source: {
          entry: resolved.source.entryDelaySec,
          siren: resolved.source.triggeredDurationSec,
        },
        ...(source !== null ? { ruleId: source.ruleId, rule: source.ruleName } : { by: 'manual' }),
      },
    })
    this.publish(now)
    return 'accepted'
  }

  private status(now: number = Date.now()): AlarmPanelStatus {
    return {
      state: stateAt(this.machine, now),
      // Settled `armed_*` and every transitional word name the mode the
      // machine belongs to — exporters (HAP/Alexa) must not invent a memo.
      targetMode: armModeOf(this.machine.target, NC_ALARM_MODES),
      availableModes: [...NC_ALARM_MODES],
      // No PIN yet. It becomes the second factor when a notification action can
      // disarm — see the alarm spec; until then claiming one would be a lie the
      // UI renders a keypad for.
      requiresCode: false,
      lastChangedAt: this.machine.changedAt,
    }
  }

  /**
   * Write the slice and keep ticking while a delay is running.
   *
   * `settle` is applied first so the PERSISTED machine does not depend on when
   * it is next read — a hub restarted mid-`pending` comes back already fired,
   * rather than fired only once somebody looks.
   */
  private publish(now: number = Date.now()): void {
    // Capture BEFORE settle: settle drops `clearToDisarmed` when it lands.
    const autoCleared =
      this.machine.clearAt !== undefined &&
      now >= this.machine.clearAt &&
      this.machine.clearToDisarmed === true
    this.machine = settle(this.machine, now)
    // EVERY disarm ends the session's bypasses — the operator's, the bridge's,
    // the cap's, and the `disableAfter` auto-disarm that only `settle` sees.
    if (this.machine.target === 'disarmed') this.endInputBypasses('disarm')
    const state = stateAt(this.machine, now)
    this.runtimeState.setCapState('alarm-panel', this.status(now))
    this.persist()
    this.report(state, now, autoCleared)
    // `clearAt` counts too: a bounded siren has to keep ticking so the panel
    // ANNOUNCES its own re-arm. Without it the state was already correct to
    // anyone who asked, and silently wrong to everyone watching.
    const transitional =
      this.machine.armedAt !== undefined ||
      this.machine.triggerAt !== undefined ||
      this.machine.clearAt !== undefined
    if (transitional) this.startTicking()
    else this.stopTicking()
  }

  /**
   * Hand the publish to whoever is listening: the state every time, the
   * transition only when there is one.
   *
   * Never throws into the publish path: a notification that could take the
   * panel's own state update with it would make a delivery failure look like
   * an alarm failure.
   */
  private report(state: AlarmState, now: number, autoCleared = false): void {
    const previous = this.lastPublished
    this.lastPublished = state
    const hook = this.onPublish
    if (hook === null) return
    const source = this.attribution.current()
    const followers = this.attribution.followers()
    // The exit delay is read from the SETTLED machine, at the same instant the
    // state was: `arming` is a bare word, and "Away in 30s" needs both halves
    // to come from one reading or the seconds belong to a different publish.
    const arming = exitDelayAt(this.machine, now)
    // …and the entry delay, for the same reason: "20s to disarm" and the mode
    // it belongs to come from the reading the state came from.
    const pending = pendingAt(this.machine, now)
    const transition = alarmTransition({
      previous,
      next: state,
      modes: NC_ALARM_MODES,
      at: now,
      ...(source !== null ? { source } : {}),
      ...(followers.length > 0 ? { followers } : {}),
      ...(arming !== undefined ? { arming } : {}),
      ...(pending !== undefined ? { pending } : {}),
      ...(autoCleared ? { autoCleared: true } : {}),
    })
    // Consumed once. The next `triggered` must not re-use this rule's subject,
    // and a bounded siren that re-arms and fires again is a NEW incident.
    if (transition?.kind === 'alarm-triggered') this.attribution.clear()
    try {
      hook({ state, target: this.machine.target, transition })
    } catch (err) {
      this.ctx.logger.warn('alarm publish hook failed', {
        tags: { deviceId: this.id },
        meta: { state, transition: transition?.kind ?? 'none', error: String(err) },
      })
    }
  }

  /**
   * What became of a match that pressed the panel during its entry delay (D705).
   * Tagged with the CAMERA the match was about — "why is 101 not in the alarm
   * picture" is asked per camera. A kept follower and a dropped one are both
   * stated: the drop is work the operator would otherwise never see go missing.
   */
  private reportFollow(outcome: NcAlarmFollowOutcome): void {
    const source = outcome.source
    const meta = {
      panelDeviceId: this.id,
      ruleId: source.ruleId,
      rule: source.ruleName,
      ...(source.trackId !== undefined ? { trackId: source.trackId } : {}),
    }
    if (outcome.kind === 'joined') {
      this.ctx.logger.info(
        'alarm trigger joined the running entry delay — it rides the alarm picture',
        {
          tags: { deviceId: source.deviceId },
          meta: { ...meta, followers: outcome.followers },
        },
      )
      return
    }
    const why =
      outcome.kind === 'duplicate'
        ? 'subject already in the incident'
        : outcome.kind === 'full'
          ? `incident already holds ${NC_ALARM_INCIDENT_MAX_FOLLOWERS} followers`
          : 'the entry delay was started by hand — no combined notification to join'
    this.ctx.logger.info('alarm trigger during the entry delay not added to the alarm picture', {
      tags: { deviceId: source.deviceId },
      meta: { ...meta, reason: outcome.kind, why },
    })
  }

  /**
   * "Ignored" is TOLD only when the excluded sensor really MOVED while armed and the
   * mode's `notifySensorIgnored` switch is on (D735, default off) — and then ONCE per
   * sensor per arm (the mark rides the persisted exclusion), and only while the panel is
   * armed: during the exit delay `trigger()` would have dropped it anyway, so the
   * exclusion is not what ignored it. A contact that was open all along and was merely
   * re-published (a provider reconnect, a Zigbee2MQTT restart) moved nothing, and four
   * such pushes reached the operator in 60 ms on 2026-10-07. Every refusal is a line.
   */
  private announceIgnoredTrigger(deviceId: number, now: number, moved: boolean): void {
    const state = stateAt(this.machine, now)
    if (!isArmed(this.machine, now)) {
      this.ctx.logger.debug('alarm bypass not announced — the panel is not armed yet', {
        tags: { deviceId },
        meta: { panelDeviceId: this.id, state },
      })
      return
    }
    // The siren is already the answer. A second push naming an excluded
    // contact ("Ignored: it was open when armed") next to ALLARME reads as a
    // re-arm message about the wrong sensor — 2026-10-05 04:31, porch door
    // triggered and hall-destra chattered 32 ms later. Do not mark either:
    // after re-arm the same chatter can still be told once while armed_*.
    if (state === 'triggered') {
      this.ctx.logger.debug('alarm bypass not announced — the siren is already sounding', {
        tags: { deviceId },
        meta: { panelDeviceId: this.id, state },
      })
      return
    }
    if (!moved) {
      this.ctx.logger.debug('alarm bypass not announced — the sensor did not move since the arm', {
        tags: { deviceId },
        meta: { panelDeviceId: this.id, state, reason: 'not-moved' },
      })
      return
    }
    const mode = armModeOf(this.machine.target, NC_ALARM_MODES)
    if (mode === null || !this.notifyPolicy(mode).notifySensorIgnored) {
      this.ctx.logger.info('alarm "ignored" not notified — the mode does not notify it', {
        tags: { deviceId },
        meta: { panelDeviceId: this.id, mode, reason: 'ignored-notify-off' },
      })
      return
    }
    if (!this.exclusions.markAnnounced(deviceId)) {
      this.ctx.logger.debug('alarm bypass already announced in this arm — repeat not sent', {
        tags: { deviceId },
        meta: { panelDeviceId: this.id },
      })
      return
    }
    this.persist()
    this.announceBypass({ deviceId, event: 'ignored' }, now)
  }

  /**
   * Report a sensor the current arm ignored, or stopped ignoring, through the
   * publish hook — a report whose state is UNCHANGED, so `lastPublished` is
   * not touched and the next real transition is still computed from it.
   */
  private announceBypass(sensor: NcAlarmBypassedSensor, now: number): void {
    const hook = this.onPublish
    if (hook === null) return
    const state = stateAt(this.machine, now)
    const transition: NcAlarmTransition = {
      kind: 'alarm-sensor-bypass',
      state,
      previous: state,
      at: now,
      sensor,
    }
    try {
      hook({ state, target: this.machine.target, transition })
    } catch (err) {
      this.ctx.logger.warn('alarm publish hook failed', {
        tags: { deviceId: this.id },
        meta: { state, transition: transition.kind, error: String(err) },
      })
    }
  }

  /** The global durations plus the per-mode overrides, read from the persisted config NOW. */
  private delaySettings(): NcAlarmDelaySettings {
    const storedAction = this.config.get('postTriggeredAction')
    return {
      exitDelaySec: this.config.get('exitDelaySec'),
      entryDelaySec: this.config.get('entryDelaySec'),
      triggeredDurationSec: this.config.get('triggeredDurationSec'),
      ...(storedAction !== undefined ? { postTriggeredAction: storedAction } : {}),
      modeDelays: modeDelaysFromPersisted(this.config.get('modeDelays')).entries,
    }
  }

  /**
   * What `mode` runs on, read at the transition that uses it — never cached. `null` (no armed
   * mode to look at) is the global values, every field `default`.
   */
  private delaysFor(mode: AlarmArmMode | null): NcAlarmResolvedDelays {
    const settings = this.delaySettings()
    if (mode === null) {
      const delays = this.readDelays()
      return {
        exitDelaySec: delays.exitDelaySec,
        entryDelaySec: delays.entryDelaySec,
        triggeredDurationSec: delays.triggeredDurationSec,
        postTriggeredAction: delays.postTriggeredAction,
        source: {
          exitDelaySec: 'default',
          entryDelaySec: 'default',
          triggeredDurationSec: 'default',
          postTriggeredAction: 'default',
        },
      }
    }
    return resolveModeDelays(settings, mode)
  }

  /** The global durations + post-triggered action, read from the persisted config. */
  private readDelays(): AlarmDelays {
    const triggeredDurationSec = this.config.get('triggeredDurationSec')
    const stored = this.config.get('postTriggeredAction')
    return {
      exitDelaySec: this.config.get('exitDelaySec'),
      entryDelaySec: this.config.get('entryDelaySec'),
      triggeredDurationSec,
      postTriggeredAction: derivePostTriggeredAction(stored, triggeredDurationSec),
    }
  }

  private startTicking(): void {
    if (this.ticker !== null) return
    this.ticker = setInterval(() => this.publish(), TICK_MS)
    this.ticker.unref?.()
  }

  private stopTicking(): void {
    if (this.ticker === null) return
    clearInterval(this.ticker)
    this.ticker = null
  }

  /** The machine rides the device's own config blob — it is small, and it must
   *  survive a restart or the alarm disarms itself on every deploy. The
   *  exclusions ride with it, for the same reason and with the same lifetime. */
  private persist(): void {
    void this.config.set('machine', { ...this.machine })
    void this.config.set('exclusions', [...this.exclusions.snapshot()])
    void this.config.set('inputBypasses', [...this.bypasses.snapshot()])
  }

  /** The session is over: drop every bypass, one line per input. */
  private endInputBypasses(why: 'disarm' | 'arm'): void {
    const ended = this.bypasses.clear()
    if (ended.length === 0) return
    void this.config.set('inputBypasses', [])
    for (const entry of ended) {
      this.ctx.logger.info('alarm input bypass ended with the arm session — watched again', {
        tags: { deviceId: entry.deviceId },
        meta: {
          panelDeviceId: this.id,
          ruleId: entry.ruleId,
          rule: entry.ruleName,
          why,
          dropped: entry.dropped,
        },
      })
    }
  }

  private restore(): void {
    this.exclusions.restore(this.config.get('exclusions'))
    const unreadable = this.bypasses.restore(this.config.get('inputBypasses'))
    if (unreadable > 0) {
      this.ctx.logger.info(
        'alarm input bypasses: persisted entries this release cannot read were dropped',
        {
          tags: { deviceId: this.id },
          meta: { dropped: unreadable },
        },
      )
    }
    const restored = machineFromPersisted(this.config.get('machine'))
    if (restored === null) return
    this.machine = restored
  }
}
