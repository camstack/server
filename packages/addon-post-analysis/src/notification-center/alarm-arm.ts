/**
 * Extracted from NotificationCenter (secureDevicesOnArm, announceArmRefused, announceArmCheckFailed, setAlarmConfig, mutateAlarmProfile, alarmSensors, alarmConfig, coverageFor, alarmSkipReason, actuateWithAttribution, pressLocalPanel, observeAlarmOpenings, pruneAlarmInputBypasses).
 * The class method forwards private state through {@link AlarmArmHost}.
 */

import { alarmRuleStillHasInput } from './alarm-runtime.js'
import type { NcAlarmOpenDevice } from './alarm/alarm-arm-guard.js'
import type { NcAlarmLive } from './alarm/alarm-live.js'
import type { NcAlarmModeCoverage } from './alarm/alarm-mode-coverage.js'
import { alarmModeCoverage } from './alarm/alarm-mode-coverage.js'
import type { NcAlarmOpening } from './alarm/alarm-openings.js'
import type { NcAlarmRefusal } from './alarm/alarm-panel-device.js'
import {
  NcAlarmSensorsReadLog,
  alarmSensorReadIds,
  alarmSensorStateOf,
} from './alarm/alarm-sensors.js'
import { DEFAULT_DELAYS } from './alarm/alarm-state-machine.js'
import type { NcAlarmTransition } from './alarm/alarm-transitions.js'
import { NcDeviceDirectory } from './device-directory.js'
import { NcDeviceMuteStore } from './device-mute-store.js'
import { ALARM_PANEL_CAP } from './granted-actions.js'
import type { NcRuleFireRef } from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import type {
  AlarmArmMode,
  AlarmState,
  IScopedLogger,
  NcAlarmConfig,
  NcAlarmProfilesView,
  NcAlarmSensors,
  NcAlarmSensorsInput,
  NcAlarmSettings,
  NcAlarmSettingsPatch,
  NcAlarmSkipReason,
} from '@camstack/types'
import { secureActuationFor } from '@camstack/types'
import type { NcAlarmPanelPort, NotificationCenterDeps } from './index.js'

/**
 * What `getAlarmConfig` answers on a node with no panel.
 *
 * The DEFAULTS, not zeroes: paired with `deviceId: null` this tells a client
 * "there is no panel here" while still describing the shape it would have.
 * Zeroes would render as "no entry delay", which is a claim about an alarm
 * that does not exist.
 */
export const NC_ALARM_SETTINGS_FALLBACK: NcAlarmSettings = {
  ...DEFAULT_DELAYS,
  announceTargets: [],
  nonBlocking: [],
  blocking: [],
  secureOnArmOff: [],
  modeDelays: [],
}

export interface AlarmArmHost {
  actuateWithAttribution(input: {
    readonly deviceId: number
    readonly cap: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly origin?: NcRuleFireRef
  }): Promise<void>
  alarmConfig(): Promise<NcAlarmConfig>
  alarmLive(panel: NcAlarmPanelPort): Promise<NcAlarmLive>
  readonly alarmPanel: NcAlarmPanelPort | null
  readonly alarmSensorsReadLog: NcAlarmSensorsReadLog
  alarmSkipReason(deviceId: number): NcAlarmSkipReason | undefined
  coverageFor(panel: NcAlarmPanelPort): readonly NcAlarmModeCoverage[]
  readonly deps: NotificationCenterDeps
  readonly deviceDirectory: NcDeviceDirectory
  readonly deviceMutes: NcDeviceMuteStore
  readonly logger: IScopedLogger
  readonly now: () => number
  pressLocalPanel(panel: NcAlarmPanelPort, origin: NcRuleFireRef | undefined): boolean
  readonly rules: NcRuleStore
  scheduleAlarmTransition(panel: NcAlarmPanelPort, transition: NcAlarmTransition): void
}

/**
 * Fire-and-forget secure actuation for controllable openings on arm.
 * Failures are WARN per device — they never refuse the arm.
 */
export async function secureDevicesOnArm(
  host: AlarmArmHost,
  devices: readonly NcAlarmOpenDevice[],
): Promise<void> {
  for (const device of devices) {
    const actuation = device.cap !== undefined ? secureActuationFor(device.cap) : null
    if (actuation === null) continue
    try {
      await host.actuateWithAttribution({
        deviceId: device.deviceId,
        cap: actuation.cap,
        method: actuation.method,
        args: { deviceId: device.deviceId, ...actuation.args },
      })
      host.logger.info('alarm secure-on-arm actuated', {
        tags: { deviceId: device.deviceId },
        meta: {
          name: device.name,
          state: device.state,
          cap: actuation.cap,
          method: actuation.method,
        },
      })
    } catch (err) {
      host.logger.warn('alarm secure-on-arm actuation failed — arm continues', {
        tags: { deviceId: device.deviceId },
        meta: {
          name: device.name,
          state: device.state,
          cap: actuation.cap,
          method: actuation.method,
          error: String(err),
        },
      })
    }
  }
}
/**
 * The refusal, as an ordinary notification.
 *
 * Same path every alarm announcement takes (D126: the alarm speaks through
 * the ordinary notification path), so it is durable, retried, in history and
 * worded in the reader's language at send time. It is the operator's ONLY
 * copy: the thrown error reaches whoever called the cap, and when that caller
 * is a notification button on a phone, nobody ever sees it. The refusal id
 * rides the transition onto the ROW, where the Arm anyway button is minted
 * from (D630).
 */
export function announceArmRefused(
  host: AlarmArmHost,
  input: {
    readonly refusal: NcAlarmRefusal
    readonly blocking: readonly NcAlarmOpenDevice[]
    readonly state: AlarmState
    readonly at: number
  },
): void {
  const panel = host.alarmPanel
  if (panel === null) return
  host.scheduleAlarmTransition(panel, {
    kind: 'alarm-arm-refused',
    // The panel did NOT change state, and the event says so: the previous
    // and the current word are the one it is in. An `alarm-arm-refused`
    // carrying the refused mode as its state would be a row claiming an arm
    // that never happened.
    state: input.state,
    previous: input.state,
    mode: input.refusal.mode,
    at: input.at,
    refusalId: input.refusal.id,
    blocking: input.blocking.map((d) => ({ deviceId: d.deviceId, name: d.name, state: d.state })),
  })
}
/**
 * The panel armed WITHOUT the openings check — nothing could be read. A
 * line on the panel AND an `alarm-check-failed` notification to its
 * recipients: "armed, but I could not check the windows" is exactly what the
 * operator has to hear before leaving.
 */
export function announceArmCheckFailed(
  host: AlarmArmHost,
  input: {
    readonly mode: AlarmArmMode
    readonly state: AlarmState
    readonly at: number
    readonly error: string
  },
): void {
  const panel = host.alarmPanel
  if (panel === null) return
  host.logger.warn('alarm armed WITHOUT the openings check — nothing could be read', {
    tags: { deviceId: panel.deviceId },
    meta: { mode: input.mode, at: input.at, error: input.error },
  })
  host.scheduleAlarmTransition(panel, {
    kind: 'alarm-check-failed',
    state: input.state,
    previous: input.state,
    mode: input.mode,
    at: input.at,
  })
}
export async function setAlarmConfig(
  host: AlarmArmHost,
  patch: NcAlarmSettingsPatch,
): Promise<NcAlarmConfig> {
  const panel = host.alarmPanel
  // Not silently ignored: a Save that returns the unchanged defaults
  // looks like it worked. This install has no panel and the operator has
  // to be told which one it is.
  if (panel === null) throw new Error('this node has no alarm panel')
  const settings = await panel.applySettings(patch)
  host.logger.info('alarm settings changed', {
    tags: { deviceId: panel.deviceId },
    meta: {
      exitDelaySec: settings.exitDelaySec,
      entryDelaySec: settings.entryDelaySec,
      triggeredDurationSec: settings.triggeredDurationSec,
      announceTargets: settings.announceTargets.length,
      modeDelays: settings.modeDelays.length,
    },
  })
  return host.alarmConfig()
}
/** Profile CRUD — each mutation returns the whole config (settings applied). */
export async function mutateAlarmProfile(
  host: AlarmArmHost,
  run: (panel: NcAlarmPanelPort) => Promise<NcAlarmProfilesView>,
): Promise<NcAlarmConfig> {
  const panel = host.alarmPanel
  if (panel === null) throw new Error('this node has no alarm panel')
  await run(panel)
  return host.alarmConfig()
}
/**
 * The opening states of the asked ids, for the alarm editors' sensor table.
 *
 * A separate read from `getAlarmConfig` on purpose: that one is polled every
 * 2–15 s and the household set needs a whole-fleet bindings pass, while the
 * client already holds the ids. Cost: one `loadRuntimeState` RPC per id, 8 in
 * flight (`readAlarmOpenings`); the client sends at most `NC_ALARM_SENSORS_MAX`
 * ids per call and polls every 15 s, every 5 s only while a countdown or the
 * siren runs. No log line per call (it is polled): one WARN/INFO per change of
 * wholesale read health (`NcAlarmSensorsReadLog`); a per-id read failure keeps
 * `readAlarmOpenings`' own debug line, and shows as `unknown` (D49).
 *
 * An id with no persisted device (removed) or whose provider never wrote an
 * opening slice reads `not-opening`, exactly as the arm check sees it — NOT
 * "verified not an opening". The client shows "Removed" from its fleet read.
 */
export async function alarmSensors(
  host: AlarmArmHost,
  input: NcAlarmSensorsInput,
): Promise<NcAlarmSensors> {
  const read = host.deps.readDeviceOpenings
  if (read === undefined) throw new Error('the opening reader is not wired on this node')
  const ids = alarmSensorReadIds(input.deviceIds)
  const openings = await read(ids)
  // Polled: a line per CHANGE of health, never per call. The rows still say
  // `unknown` for every unanswered id.
  const line = host.alarmSensorsReadLog.next(ids.length, openings.size)
  if (line !== null) {
    const panelId = host.alarmPanel?.deviceId
    host.logger[line.level](line.message, {
      ...(panelId === undefined ? {} : { tags: { deviceId: panelId } }),
      meta: line.meta,
    })
  }
  return {
    sensors: ids.map((id) =>
      alarmSensorStateOf(id, openings.get(id), host.deviceDirectory.get(id)?.online ?? null),
    ),
    readAt: Date.now(),
  }
}
/** Settings + the DERIVED coverage + the live panel. Read together — see the cap doc. */
export async function alarmConfig(host: AlarmArmHost): Promise<NcAlarmConfig> {
  const panel = host.alarmPanel
  if (panel === null) return { deviceId: null, settings: NC_ALARM_SETTINGS_FALLBACK, coverage: [] }
  return {
    deviceId: panel.deviceId,
    settings: panel.settings(),
    profiles: panel.profilesView(),
    live: await host.alarmLive(panel),
    // Copied into mutable arrays at the cap boundary: the derivation returns
    // readonly values so nothing downstream can edit a coverage list in place.
    coverage: host.coverageFor(panel).map((c) => ({
      ...c,
      deviceIds: [...c.deviceIds],
      allDevicesExcept: [...c.allDevicesExcept],
      skippedDevices: c.skippedDevices.map((s) => ({ ...s })),
    })),
  }
}
export function coverageFor(
  host: AlarmArmHost,
  panel: NcAlarmPanelPort,
): readonly NcAlarmModeCoverage[] {
  return alarmModeCoverage(host.rules.list(), panel.deviceId, panel.availableModes(), (deviceId) =>
    host.alarmSkipReason(deviceId),
  )
}
/**
 * Why a device a mode names is not actually armed — from the authorities that
 * already own each answer (D62), in the order an operator would act on them.
 *
 * `muted` first because it is the centre's OWN switch and the only one it can
 * answer with certainty; then the two mirrored facts. A device the directory
 * cannot place answers `undefined`: a cold mirror must never report every
 * camera as excluded, which would turn the alarm tab into a wall of red on
 * the first thirty seconds after every deploy.
 */
export function alarmSkipReason(
  host: AlarmArmHost,
  deviceId: number,
): NcAlarmSkipReason | undefined {
  if (host.deviceMutes.isMuted(deviceId)) return 'muted'
  const identity = host.deviceDirectory.get(deviceId)
  if (identity === undefined) return undefined
  if (identity.online === false) return 'offline'
  // ONLY a camera can have detection switched off. A contact sensor has no
  // detection pipeline and never will, so its `detectionActive: false` is an
  // absence, not a switch — and reading it as one made the whole of `home`
  // report as excluded the moment seven contacts joined it. Live, 17:48:
  // "Attivo tra 30 secondi — ma ogni dispositivo coperto da questa modalità è
  // escluso: non proteggerà nulla" [Active in 30 seconds — but every device covered by this mode is excluded: it will protect nothing], about a mode arming seven working
  // sensors. The rule that this reads an authority (D62) is unchanged; what
  // was wrong is that the authority does not answer for this kind of device.
  if (identity.isCamera && identity.detectionActive === false) return 'detection-off'
  // `undefined` is "this hub has not told us" — only an explicit false is a
  // detection switch somebody turned off.
  return undefined
}
/**
 * The one actuation seam of this centre — a rule's sequence step, a granted button.
 *
 * A press of THIS node's panel `trigger` never reaches the actuator: with a match
 * (`origin`) it is {@link NcAlarmPanelPort.triggerFromRule}, synchronously, the source
 * in the call. The join is HERE rather than in the runner: the runner actuates devices
 * generically and must not learn what an alarm is, while this class holds the panel.
 *
 * Without a match, the press has no sensor to check against the arm's exclusions, so
 * while the arm EXCLUDES anything it is REFUSED (fail-closed, D735): an anonymous press
 * from this seam is exactly what sounded the siren off an excluded contact on
 * 2026-10-07. A person's manual trigger (the panel's cap, from the UI) does not come
 * through here and is unaffected.
 */
export async function actuateWithAttribution(
  host: AlarmArmHost,
  input: {
    readonly deviceId: number
    readonly cap: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly origin?: NcRuleFireRef
  },
): Promise<void> {
  const panel = host.alarmPanel
  if (
    panel !== null &&
    input.deviceId === panel.deviceId &&
    input.cap === ALARM_PANEL_CAP &&
    input.method === 'trigger' &&
    host.pressLocalPanel(panel, input.origin)
  ) {
    return
  }
  const actuate = host.deps.actuate
  if (actuate === undefined) throw new Error('no actuator is wired on this node')
  await actuate(input)
}
/**
 * A press of this node's panel from the actuation seam; true when it was handled here.
 * With a source: the panel's rule press. Without one: refused while the arm excludes any
 * sensor — an ERROR line and a throw, so the sequence step reports failed instead of
 * looking done. Without one and nothing excluded: false, and the press takes the cap
 * like any manual press (there is no sensor whose exclusion it could skip).
 */
export function pressLocalPanel(
  host: AlarmArmHost,
  panel: NcAlarmPanelPort,
  origin: NcRuleFireRef | undefined,
): boolean {
  if (origin !== undefined) {
    panel.triggerFromRule(origin)
    return true
  }
  const excluded = panel.excludedDevices()
  if (excluded.length === 0) return false
  host.logger.error(
    'alarm trigger REFUSED — a rule-action press carried no source while the arm excludes sensors',
    {
      tags: { deviceId: panel.deviceId },
      meta: { excluded: excluded.join(','), state: panel.currentState() },
    },
  )
  throw new Error('alarm trigger refused: no source, and the current arm excludes sensors')
}
export async function observeAlarmOpenings(host: AlarmArmHost): Promise<void> {
  const panel = host.alarmPanel
  const read = host.deps.readDeviceOpenings
  if (panel === null || read === undefined) return
  const excluded = panel.excludedDevices()
  if (excluded.length === 0) return
  let openings: ReadonlyMap<number, NcAlarmOpening>
  try {
    openings = await read(excluded)
  } catch (err) {
    host.logger.warn('alarm exclusion reconcile: the openings read failed — nothing lifted', {
      tags: { deviceId: panel.deviceId },
      meta: { excluded: excluded.length, error: String(err) },
    })
    return
  }
  const now = host.now()
  for (const deviceId of excluded) {
    const opening = openings.get(deviceId)
    if (opening?.kind !== 'reading') continue
    panel.observeOpening(deviceId, opening.reading, now)
  }
}
/**
 * Read every excluded device's opening and feed it back to the panel.
 *
 * The reconcile half of the two-phase lift. The EVENT half
 * ({@link observeOpeningEvent}) is the fast one, but an event can be dropped
 * (D8), so the tick re-reads the handful of excluded devices — through the
 * same `readDeviceOpenings` table the arm check uses, so a cover lifts on
 * `closed` and a lock on `locked` exactly as on the event path. A device the
 * read cannot answer for, or that reads unknown, changes nothing (D49).
 * Never throws into the tick.
 */
export function pruneAlarmInputBypasses(host: AlarmArmHost): void {
  const panel = host.alarmPanel
  if (panel === null || panel.inputBypasses().length === 0) return
  panel.pruneInputBypasses((entry) =>
    alarmRuleStillHasInput(host.rules.get(entry.ruleId) ?? null, entry),
  )
}
