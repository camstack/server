/**
 * What a mode actually arms — DERIVED from the rules in force, never kept.
 *
 * "Away armed" is a promise, and the operator has no way to check it. The only
 * thing that makes the panel do anything is a rule gated on the panel's state
 * (`conditions.deviceState = { deviceId: <panel>, states: ['armed_away'] }`),
 * so the set of devices a mode covers is a FUNCTION of the rule set. Reading it
 * from anywhere else — a list on the panel, a field on the mode — creates a
 * second registry that drifts the first time somebody disables a rule, and the
 * operator is then told the garage is armed by a rule that no longer runs.
 * (D12 in another shape: walk the bindings, never a parallel copy.)
 *
 * Everything here is pure. The announcement is composed from these values by
 * {@link buildArmAnnouncement}; delivery is the dispatcher's.
 */

import type {
  AlarmArmMode,
  AlarmState,
  NcAlarmSkippedDevice,
  NcAlarmSkipReason,
  NcConditions,
} from '@camstack/types'

/**
 * The two fields of a rule this derivation reads.
 *
 * Narrowed rather than taking `NcRule`: an `NcRule` is structurally assignable
 * to it, so the caller passes the real thing, and a test does not have to
 * fabricate twenty fields no assertion looks at. A fake that must be
 * hand-built is a fake that drifts.
 */
export interface NcAlarmGatingRule {
  readonly enabled: boolean
  readonly conditions: Pick<NcConditions, 'deviceState' | 'devices' | 'devicesExclude'>
}

/**
 * Whether the panel just BECAME armed, in the sense a person means.
 *
 * Two transitions reach an `armed_*` state and only one of them is an arm:
 *
 *  - `arming`/`disarmed` → `armed_away` is somebody arming the alarm. Announce.
 *  - `triggered` → `armed_away` is the siren's duration ending and the panel
 *    re-arming itself. It is told too (D630), but as `alarm-rearmed`, never as
 *    an arm: "Away armed" in the middle of a break-in would read as somebody
 *    arming it. `alarmTransition` routes it there before asking this.
 *
 * `armed_home` → `armed_away` IS an arm: the operator changed mode, and the
 * set of devices covered just changed with it — which is the whole content of
 * the message.
 *
 * A null `previous` is the FIRST publish and never announces. A hub restarting
 * while armed re-publishes `armed_away`, and nobody armed anything — every
 * deploy would otherwise send one. Handled here rather than by the caller
 * happening to wire the hook late, because "it works because of the order two
 * unrelated things run in" is how this stops working.
 */
export function shouldAnnounceArm(previous: AlarmState | null, next: AlarmState): boolean {
  if (previous === null) return false
  if (!next.startsWith('armed_')) return false
  if (previous === next) return false
  if (previous === 'triggered') return false
  return true
}

/** The mode inside an `armed_<mode>` state, or null for any other state. */
export function armModeOf(state: AlarmState, modes: readonly AlarmArmMode[]): AlarmArmMode | null {
  for (const mode of modes) {
    if (state === armedStateFor(mode)) return mode
  }
  return null
}

/** The `deviceState` word a rule must gate on for `mode` to cover it. */
export function armedStateFor(mode: AlarmArmMode): string {
  return `armed_${mode}`
}

export interface NcAlarmModeCoverage {
  readonly mode: AlarmArmMode
  /** Enabled rules gated on this mode. Zero means the mode does nothing. */
  readonly ruleCount: number
  /**
   * True when at least one covering rule has NO `devices` condition, so the
   * mode applies to every device. `deviceIds` is then still the ids named by
   * the other rules — it is a subset, not the answer, and a caller that
   * renders it as the answer would understate the coverage.
   */
  readonly allDevices: boolean
  /**
   * D641: ids NOT covered although `allDevices` is true — excluded by every
   * unscoped covering rule and named by none. `[]` otherwise. Excluded by the
   * RULES, so never in {@link skippedDevices}.
   */
  readonly allDevicesExcept: readonly number[]
  /**
   * Device ids named by the covering rules (each rule's list minus its own
   * `devicesExclude`), ascending and de-duplicated.
   */
  readonly deviceIds: readonly number[]
  /** Named devices this mode cannot actually arm — see {@link NcAlarmSkipProbe}. */
  readonly skippedDevices: readonly NcAlarmSkippedDevice[]
}

/**
 * Why a device a mode NAMES is not actually armed by it — asked of the
 * authorities that already own each answer, never of a list kept here.
 *
 * Every one of these is a switch the operator used somewhere else: the
 * per-camera notification mute the centre itself owns, the detection wrapper
 * binding, the device manager's liveness. D62: a per-camera function switch
 * stores nothing and reads the authority that already owned the function — a
 * second copy would start disagreeing with the switch the operator actually
 * flipped, and the panel would then promise protection nobody has.
 *
 * `undefined` = nothing is known to exclude it. An UNREADABLE authority must
 * answer `undefined` and never a reason: reporting a device as excluded because
 * a read failed would tell an operator to go fix a camera that is fine.
 */
export type NcAlarmSkipProbe = (deviceId: number) => NcAlarmSkipReason | undefined

/**
 * One entry per mode the panel offers, including modes nothing is gated on.
 *
 * Empty modes are KEPT rather than filtered: "Night arms nothing" is the single
 * most useful thing this can tell an operator, and a list that omits it looks
 * identical to a list where night is covered.
 */
export function alarmModeCoverage(
  rules: readonly NcAlarmGatingRule[],
  panelDeviceId: number,
  modes: readonly AlarmArmMode[],
  skipProbe?: NcAlarmSkipProbe,
): readonly NcAlarmModeCoverage[] {
  return modes.map((mode) => coverageFor(rules, panelDeviceId, mode, skipProbe))
}

function coverageFor(
  rules: readonly NcAlarmGatingRule[],
  panelDeviceId: number,
  mode: AlarmArmMode,
  skipProbe: NcAlarmSkipProbe | undefined,
): NcAlarmModeCoverage {
  const wanted = armedStateFor(mode)
  const ids = new Set<number>()
  let ruleCount = 0
  let allDevices = false
  // D641. `null` = no unscoped rule yet; `'none'` = one unscoped rule excludes
  // nothing, so nothing can ever be uncovered again. Otherwise the ids EVERY
  // unscoped rule so far excludes — a device one of them covers is covered.
  let except: ReadonlySet<number> | 'none' | null = null
  for (const rule of rules) {
    // A disabled rule arms nothing. Counting it would make the panel report
    // protection the operator switched off.
    if (!rule.enabled) continue
    const gate = rule.conditions.deviceState
    if (gate === undefined || gate.deviceId !== panelDeviceId) continue
    if (!gate.states.includes(wanted)) continue
    ruleCount += 1
    const scope = rule.conditions.devices
    const excluded = rule.conditions.devicesExclude ?? []
    if (scope === undefined || scope.length === 0) {
      allDevices = true
      except = narrowExcept(except, excluded)
      continue
    }
    for (const id of scope) if (!excluded.includes(id)) ids.add(id)
  }
  const deviceIds = [...ids].toSorted((a, b) => a - b)
  const allDevicesExcept =
    except === null || except === 'none'
      ? []
      : [...except].filter((id) => !ids.has(id)).toSorted((a, b) => a - b)
  return {
    mode,
    ruleCount,
    allDevices,
    allDevicesExcept,
    deviceIds,
    // Only the NAMED devices. An `allDevices` mode covers every camera on the
    // hub and listing every muted one of them would bury the answer — the
    // exclusions worth reporting are the ones the operator wrote down.
    skippedDevices: skippedFor(deviceIds, skipProbe),
  }
}

/**
 * Fold one UNSCOPED covering rule into the except-set: with no exclusion it
 * covers everything (`'none'`, final); otherwise only what every unscoped rule
 * excludes stays uncovered — the intersection.
 */
function narrowExcept(
  current: ReadonlySet<number> | 'none' | null,
  excluded: readonly number[],
): ReadonlySet<number> | 'none' {
  if (current === 'none' || excluded.length === 0) return 'none'
  if (current === null) return new Set(excluded)
  return new Set(excluded.filter((id) => current.has(id)))
}

function skippedFor(
  deviceIds: readonly number[],
  skipProbe: NcAlarmSkipProbe | undefined,
): readonly NcAlarmSkippedDevice[] {
  if (skipProbe === undefined) return []
  const out: NcAlarmSkippedDevice[] = []
  for (const deviceId of deviceIds) {
    const reason = skipProbe(deviceId)
    if (reason !== undefined) out.push({ deviceId, reason })
  }
  return out
}

/**
 * The arm sentence as a catalog KEY plus the facts that fill it — never as
 * finished words.
 *
 * The words are chosen at DELIVERY, where the reader's language is known; the
 * facts are chosen here, where the coverage is. That split is the same one
 * every other system notification makes, and it is what lets an arm
 * announcement sit in the outbox behind an unreachable target and still be
 * delivered — translated, and re-worded if the operator overrode the text —
 * rather than draining as the sentence the hub happened to speak that night.
 */
export interface NcArmAnnouncementText {
  readonly bodyKey: string
  readonly textParams: Readonly<Record<string, string>>
  /** The number the body pluralises on. Rules and devices are DIFFERENT
   *  numbers pluralising independently, which is why the variant carries its
   *  own rather than sharing one. */
  readonly textCount: number
  /**
   * Optional title-key suffix after `system.alarm-armed.title.<mode>` /
   * `system.alarm-arming.title.<mode>`. `all` is the covered-everything mode,
   * which has no finite Active count for the title's `(n attivi, m saltati)`.
   */
  readonly titleKeySuffix?: 'all'
}

/**
 * `active` / `skipped` for the arm / arming TITLE — `(n attivi, m saltati)`.
 *
 * Named coverage only: an `allDevices` mode has no finite Active set, so the
 * caller picks the `.all` title key instead of stuffing a fake number here.
 */
function armCountParams(
  coverage: NcAlarmModeCoverage,
  bypassed: readonly number[] = [],
): { readonly active: string; readonly skipped: string } {
  const skipped = new Set(coverage.skippedDevices.map((s) => s.deviceId))
  for (const id of bypassed) skipped.add(id)
  const active = coverage.deviceIds.filter((id) => !skipped.has(id)).length
  return { active: `${active}`, skipped: `${skipped.size}` }
}

/** Name for a device id, with its number as the last resort. */
export type NcDeviceNameLookup = (deviceId: number) => string

/**
 * The two ways an arm can be a promise the hub cannot keep.
 *
 * NOT a refusal. A gap never stops an arm: the only thing that refuses one is
 * an OPENING that is open when the mode is armed (D630, `decideArm` in
 * `alarm-arm-guard.ts`). A gap is a mode that, once armed, watches nothing:
 * either because no enabled rule is gated on it, or because every device the
 * gated rules name is muted, offline or has detection switched off. Both are
 * reported IN the arm notification, so the sentence that says "armed" also
 * says what that is worth.
 */
export type NcAlarmCoverageGap = 'uncovered' | 'all-skipped'

/**
 * Whether this mode arms anything, and if not, which way it fails.
 *
 * An `allDevices` mode is never a gap: `skippedDevices` only ever probes the
 * ids a rule wrote down, so it cannot answer for a mode that covers every
 * camera on the hub, and reporting "all excluded" from a subset would be a
 * warning about protection that exists.
 */
export function alarmCoverageGap(coverage: NcAlarmModeCoverage): NcAlarmCoverageGap | null {
  if (coverage.ruleCount === 0) return 'uncovered'
  if (coverage.allDevices) return null
  if (coverage.deviceIds.length === 0) return null
  if (coverage.skippedDevices.length < coverage.deviceIds.length) return null
  return 'all-skipped'
}

/** Device names as a lock-screen bullet list (one name per line). */
function bulletDeviceNames(names: readonly string[]): string {
  return names.map((n) => `• ${n}`).join('\n')
}

/**
 * Skipped / excluded devices FIRST, then active — each name on its own
 * `•` line. The mode is in the title; the body answers "which ones".
 */
export function buildArmAnnouncement(
  coverage: NcAlarmModeCoverage,
  deviceName: NcDeviceNameLookup,
  /**
   * Sensors this arm is deliberately IGNORING because they were open when the
   * operator confirmed it — see `alarm-exclusions.ts`.
   *
   * It outranks every other variant, and that ordering is the message: a mode
   * armed around an open window is a different promise from the same mode
   * armed with everything shut, and the sentence has to say which one the
   * operator just made. The other variants describe what the RULES cover; this
   * one describes what the operator agreed to give up.
   */
  bypassed: readonly number[] = [],
): NcArmAnnouncementText {
  const rules = `${coverage.ruleCount}`
  const mode = coverage.mode
  if (bypassed.length > 0) return armedWithBypass(coverage, bypassed, deviceName)
  const gap = alarmCoverageGap(coverage)
  if (gap === 'uncovered') {
    return {
      bodyKey: 'alarm.arm.body.uncovered',
      textParams: { mode, active: '0', skipped: '0' },
      textCount: 0,
    }
  }
  if (gap === 'all-skipped') {
    const names = coverage.skippedDevices.map((s) => deviceName(s.deviceId))
    return {
      bodyKey: 'alarm.arm.body.allSkipped',
      textParams: {
        rules,
        mode,
        devices: `${names.length}`,
        names: bulletDeviceNames(names),
        active: '0',
        skipped: `${names.length}`,
      },
      textCount: names.length,
    }
  }
  if (coverage.allDevices && coverage.allDevicesExcept.length > 0) {
    // D641: every device BUT the ones the rules exclude — named, because the
    // question at the door is "which one is not watched".
    const names = coverage.allDevicesExcept.map(deviceName)
    return {
      bodyKey: 'alarm.arm.body.allDevicesExcept',
      textParams: { rules, mode, count: `${names.length}`, names: bulletDeviceNames(names) },
      textCount: names.length,
      titleKeySuffix: 'all',
    }
  }
  if (coverage.allDevices) {
    return {
      bodyKey: 'alarm.arm.body.allDevices',
      textParams: { rules, mode },
      textCount: coverage.ruleCount,
      titleKeySuffix: 'all',
    }
  }
  if (coverage.deviceIds.length === 0) {
    // Gated rules exist but name no device — they apply to whatever their other
    // conditions match. Say so rather than printing an empty list.
    return {
      bodyKey: 'alarm.arm.body.noDevices',
      textParams: { rules, mode, active: '0', skipped: '0' },
      textCount: coverage.ruleCount,
    }
  }
  const skipped = new Set(coverage.skippedDevices.map((s) => s.deviceId))
  const names = coverage.deviceIds.filter((id) => !skipped.has(id)).map(deviceName)
  const counts = armCountParams(coverage)
  if (skipped.size === 0) {
    return {
      bodyKey: 'alarm.arm.body.devices',
      textParams: {
        rules,
        mode,
        devices: `${names.length}`,
        names: bulletDeviceNames(names),
        ...counts,
      },
      textCount: names.length,
    }
  }
  // The count pluralises on what IS armed — the promise, not the exception.
  return {
    bodyKey: 'alarm.arm.body.devicesSkipped',
    textParams: {
      rules,
      mode,
      devices: `${names.length}`,
      names: bulletDeviceNames(names),
      skippedNames: bulletDeviceNames(coverage.skippedDevices.map((s) => deviceName(s.deviceId))),
      ...counts,
    },
    textCount: names.length,
  }
}

/**
 * "Attivi: Porta retro, Cancello — Bypassati: Finestra porch."
 *
 * Both halves are named: the bypassed sensors are why the operator pressed
 * Arm anyway, and the remaining ones are what is still promised. An
 * all-devices mode has no finite list to name — it uses a dedicated key.
 */
function armedWithBypass(
  coverage: NcAlarmModeCoverage,
  bypassed: readonly number[],
  deviceName: NcDeviceNameLookup,
): NcArmAnnouncementText {
  const skipped = new Set(coverage.skippedDevices.map((s) => s.deviceId))
  const excluded = new Set(bypassed)
  const bypassedNames = bulletDeviceNames(bypassed.map(deviceName))
  if (coverage.allDevices) {
    return {
      bodyKey: 'alarm.arm.body.bypassedAll',
      textParams: {
        rules: `${coverage.ruleCount}`,
        mode: coverage.mode,
        bypassedNames,
      },
      textCount: coverage.ruleCount,
      titleKeySuffix: 'all',
    }
  }
  const armedIds = coverage.deviceIds.filter((id) => !skipped.has(id) && !excluded.has(id))
  const names = bulletDeviceNames(armedIds.map(deviceName))
  const counts = armCountParams(coverage, bypassed)
  return {
    bodyKey: 'alarm.arm.body.bypassed',
    textParams: {
      rules: `${coverage.ruleCount}`,
      mode: coverage.mode,
      devices: `${armedIds.length}`,
      names,
      bypassedNames,
      ...counts,
    },
    textCount: armedIds.length,
  }
}

/**
 * "Aperti: Finestra porch, Porta retro" + where the Arm anyway is.
 *
 * The one alarm sentence about something that did not happen, so it has to
 * carry both halves an operator needs to act: WHICH devices are open, and —
 * when the notification carries the button — that its Arm anyway arms without
 * them (D630: pressing arm again is refused again; there is no second-press
 * bypass any more, so the sentence never says "repeat within N seconds").
 * Naming them is the whole message, so the names are the FIRST line.
 */
export function buildArmRefusedAnnouncement(
  mode: AlarmArmMode,
  /**
   * The NAMES, already resolved — not ids plus a lookup like every other
   * builder here.
   *
   * The refusal's sensors are named by whoever read their state, at the moment
   * they were read. Re-deriving the name here would let the sentence disagree
   * with the log line and with the error the caller of the cap received, about
   * the same sensor, seconds apart.
   */
  names: readonly string[],
  /** Whether the row carries the refusal's Arm anyway button (it has a refusal id). */
  withArmAnyway: boolean,
): NcArmAnnouncementText {
  return {
    bodyKey: withArmAnyway ? 'alarm.armRefused.body.hint' : 'alarm.armRefused.body',
    textParams: {
      mode,
      devices: `${names.length}`,
      names: bulletDeviceNames(names),
    },
    // Pluralises on the OPEN sensors: "la finestra è aperta" / "2 sensori sono
    // aperti" [the window is open / 2 sensors are open] is the half of this sentence a person reads first.
    textCount: names.length,
  }
}

/**
 * The same coverage lists as {@link buildArmAnnouncement}, said at second 0.
 *
 * The countdown lives in the TITLE (`system.alarm-arming.title.<mode>` renders
 * `{{seconds}}`); the body is the labelled device lists — Active and Skipped
 * (and Bypassed when the operator confirmed an open sensor). Saying the lists
 * only at second 30 left the exit-delay push as "No exclusions" / a lone
 * Esclusi line, which is exactly when the operator can still disarm and fix
 * a mute or an offline camera.
 *
 * `seconds` stays in the params because the title asks for it, and `textCount`
 * stays with it: a row enqueued before this deploy still pluralises on the
 * countdown it was written for.
 */
export function buildArmingAnnouncement(
  coverage: NcAlarmModeCoverage,
  seconds: number,
  deviceName: NcDeviceNameLookup,
  /** Sensors the confirmed bypass is excluding — see {@link buildArmAnnouncement}. */
  bypassed: readonly number[] = [],
): NcArmAnnouncementText {
  const mode = coverage.mode
  const rules = `${coverage.ruleCount}`
  const textParams: Record<string, string> = { mode, seconds: `${seconds}` }
  if (bypassed.length > 0) {
    // Said at second 0 as well as at second 30, deliberately: this is the
    // window in which the operator can still disarm and go shut the window,
    // and it is the only sentence that reaches them while that is still true.
    return armingWithBypass(coverage, seconds, bypassed, deviceName)
  }
  const gap = alarmCoverageGap(coverage)
  if (gap === 'uncovered') {
    return {
      bodyKey: 'alarm.arming.body.uncovered',
      textParams: { ...textParams, active: '0', skipped: '0' },
      textCount: seconds,
    }
  }
  if (gap === 'all-skipped') {
    const names = coverage.skippedDevices.map((s) => deviceName(s.deviceId))
    return {
      bodyKey: 'alarm.arming.body.allSkipped',
      textParams: {
        ...textParams,
        rules,
        devices: `${names.length}`,
        names: bulletDeviceNames(names),
        active: '0',
        skipped: `${names.length}`,
      },
      textCount: seconds,
    }
  }
  if (coverage.allDevices && coverage.allDevicesExcept.length > 0) {
    const names = coverage.allDevicesExcept.map(deviceName)
    return {
      bodyKey: 'alarm.arming.body.allDevicesExcept',
      textParams: {
        ...textParams,
        rules,
        count: `${names.length}`,
        names: bulletDeviceNames(names),
      },
      textCount: seconds,
      titleKeySuffix: 'all',
    }
  }
  if (coverage.allDevices) {
    return {
      bodyKey: 'alarm.arming.body.allDevices',
      textParams: { ...textParams, rules },
      textCount: seconds,
      titleKeySuffix: 'all',
    }
  }
  if (coverage.deviceIds.length === 0) {
    return {
      bodyKey: 'alarm.arming.body.noDevices',
      textParams: { ...textParams, rules, active: '0', skipped: '0' },
      textCount: seconds,
    }
  }
  const skipped = new Set(coverage.skippedDevices.map((s) => s.deviceId))
  const names = coverage.deviceIds.filter((id) => !skipped.has(id)).map(deviceName)
  const counts = armCountParams(coverage)
  if (skipped.size === 0) {
    return {
      bodyKey: 'alarm.arming.body.devices',
      textParams: {
        ...textParams,
        rules,
        devices: `${names.length}`,
        names: bulletDeviceNames(names),
        ...counts,
      },
      textCount: seconds,
    }
  }
  return {
    bodyKey: 'alarm.arming.body.devicesSkipped',
    textParams: {
      ...textParams,
      rules,
      devices: `${names.length}`,
      names: bulletDeviceNames(names),
      skippedNames: bulletDeviceNames(coverage.skippedDevices.map((s) => deviceName(s.deviceId))),
      ...counts,
    },
    textCount: seconds,
  }
}

/**
 * "Attivi: Porta retro, Cancello — Bypassati: Finestra porch" while the exit
 * delay still runs — same halves as {@link armedWithBypass}, with `seconds`
 * frozen for the title.
 */
function armingWithBypass(
  coverage: NcAlarmModeCoverage,
  seconds: number,
  bypassed: readonly number[],
  deviceName: NcDeviceNameLookup,
): NcArmAnnouncementText {
  const skipped = new Set(coverage.skippedDevices.map((s) => s.deviceId))
  const excluded = new Set(bypassed)
  const bypassedNames = bulletDeviceNames(bypassed.map(deviceName))
  const textParams: Record<string, string> = {
    mode: coverage.mode,
    seconds: `${seconds}`,
    rules: `${coverage.ruleCount}`,
    bypassedNames,
  }
  if (coverage.allDevices) {
    return {
      bodyKey: 'alarm.arming.body.bypassedAll',
      textParams,
      textCount: seconds,
      titleKeySuffix: 'all',
    }
  }
  const armedIds = coverage.deviceIds.filter((id) => !skipped.has(id) && !excluded.has(id))
  const counts = armCountParams(coverage, bypassed)
  // No named Active list (uncovered mode, or every named device is skipped /
  // bypassed): say only what was bypassed — an empty "Active:" line reads as
  // a hole, not as "nothing else is armed".
  if (armedIds.length === 0) {
    return {
      bodyKey: 'alarm.arming.body.bypassedOnly',
      textParams: {
        mode: coverage.mode,
        seconds: `${seconds}`,
        bypassedNames,
        ...counts,
      },
      textCount: seconds,
    }
  }
  return {
    bodyKey: 'alarm.arming.body.bypassed',
    textParams: {
      ...textParams,
      devices: `${armedIds.length}`,
      names: bulletDeviceNames(armedIds.map(deviceName)),
      ...counts,
    },
    textCount: seconds,
  }
}
