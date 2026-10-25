/**
 * Replacing a camera: the new hardware becomes the device the system knows.
 *
 * ## Why the NUMBER moves instead of the work
 *
 * Everything general about a camera is keyed on the numeric `deviceId` and on
 * nothing else. The recording path on disk is `<deviceId>/profile/…`; the hour
 * ledger, the media store and zone ownership carry `deviceId` without one
 * `stableId` between them; and all four ecosystem exports — Home Assistant,
 * Alexa, HomeKit, Google — key on it. Moving that work would mean renaming
 * directories, rewriting a durable ledger and re-establishing four external
 * integrations. Moving the number is two rows ({@link DeviceRowStore.swapIds}).
 *
 * ## The rule the swap must obey
 *
 * **Role-scoped state follows the NUMBER. Hardware-scoped state follows the
 * DEVICE.** Tracks, faces, scenes, recordings, notification mutes — the work —
 * key on the number and stay put. State that DESCRIBES the box — the driver
 * config (host/credentials/`deviceCache`), the runtime-state slices, the
 * broker's probed snapshots, profile assignment and derived streams — must
 * move with it or be re-derived from the hardware now wearing the number
 * (`swapHardwareState`, `forgetStreamState`). Getting this wrong put two live
 * cameras in each other's identity on 2026-09-01: the new camera was dialled
 * at the old one's dead address forever, and a derived feeder defined against
 * the old profile layout respawned every ten seconds.
 *
 * ## The one thing this must never do
 *
 * Report a function as switched off when it could not ask.
 *
 * The source camera in a replacement is, characteristically, BROKEN — that is
 * why it is being replaced. Two of the eight switches (`privacy-mask` and
 * `device-audio`) write the CAMERA rather than the server: the camera holds the
 * fact and every read is a read-through, so on a dead camera they cannot be
 * written at all. A step that swallowed those failures would announce a device
 * put safely to sleep while it was still able to produce data, and the caller
 * would have no way to tell.
 *
 * So every switch gets an outcome of its own — {@link SwitchOutcome} — and
 * `unreachable` is a first-class answer, distinct both from `off` and from
 * `not-offered` (a switch this camera never had). The migration proceeds; the
 * report says what was actually done.
 *
 * ## Every switch write is BOUNDED — and the bound is honest
 *
 * A write that does not answer within {@link SWITCH_WRITE_TIMEOUT_MS} is
 * reported `unreachable` and the migration moves on. Measured on 2026-09-01: a
 * single unanswered write burned the transport's 60 s default, three phases
 * burned three minutes, and the CALLER's own timeout expired first — which is
 * how one migration became two (see `migrate-guard.ts`). Two rules the bound
 * must not break: a timed-out write is NEVER folded into `off`/`on` (a camera
 * we could not ask was not silenced), and the underlying write may still land
 * after the bound — which is safe, because every switch authority is
 * idempotent under a duplicate write of the same value.
 *
 * ## Order
 *
 * Claims first (a device under customization is refused before anything is
 * touched — D663), then functions down on BOTH devices, then the swap, then
 * functions up on the target — the device now answering on the inherited
 * number. Down-first is not
 * cosmetic: between the two writes a runner still holding the old number would
 * otherwise write frames, events or notifications against the wrong camera.
 *
 * ## After the disable phase, a failure is one of two things
 *
 * - **Refused, nothing moved** ({@link MigrationRefusedError}: a `swapIds`
 *   precheck, a failed mirror drain, a claim that landed during the start).
 *   Both cameras are put back EXACTLY as they were — the switch states read
 *   before the disable phase — never left
 *   dark for a migration that did not happen.
 * - **Failed while moving** (any other throw from `swapIds`, any throw from
 *   `swapHardwareState`). The devices may wear each other's identity, so they
 *   stay OFF and each gets an ERROR line naming what moved and that an
 *   operator must intervene. Switching them on would run pipelines against
 *   crossed identities.
 */
import type { CameraSwitchId } from '@camstack/types'
import { CAMERA_SWITCH_ORDER } from '@camstack/types'
import { MigrationRefusedError } from './migration-refused.js'

/**
 * Upper bound for ONE switch write. Generous against a live camera (a real
 * write is sub-second; the camera-plane pair is a few seconds of HTTP) and
 * small against the alternative: the 60 s transport default that let three
 * phases burn three minutes on 2026-09-01.
 */
export const SWITCH_WRITE_TIMEOUT_MS = 15_000

/** The pair a migration names on every line. */
interface MigrationIds {
  readonly sourceId: number
  readonly targetId: number
}

/** What actually happened to one switch on one device. */
export type SwitchOutcome = 'off' | 'on' | 'not-offered' | 'unreachable'

export interface SwitchReport {
  readonly deviceId: number
  readonly switchId: CameraSwitchId
  readonly outcome: SwitchOutcome
  /** The refusal, verbatim, when the outcome is not the requested one. */
  readonly detail?: string
}

export interface MigrateDeviceResult {
  readonly sourceId: number
  readonly targetId: number
  /** Every switch write attempted, in order, on both devices. */
  readonly switches: readonly SwitchReport[]
  /**
   * Switches that could NOT be turned off on the source. Empty is the only
   * value that means "the old camera is fully quiet"; a caller that renders
   * only a success flag is not entitled to one.
   */
  readonly sourceStillLive: readonly CameraSwitchId[]
  readonly swapped: boolean
}

/**
 * A camera's switch states as read before the disable phase: every switch the
 * camera OFFERS, with its state. A switch it does not offer is absent.
 */
export type SwitchStates = ReadonlyMap<CameraSwitchId, boolean>

/** Severity of a per-device migration line. */
export type MigrationLogLevel = 'warn' | 'error'

export interface MigrateDeviceDeps {
  /** `pipelineOrchestrator.setCameraSwitch`, through `ctx.api`. */
  readonly setSwitch: (
    deviceId: number,
    switchId: CameraSwitchId,
    enabled: boolean,
  ) => Promise<void>
  /** `DeviceRowStore.swapIds`, already under the meta write lock. */
  readonly swapIds: (a: number, b: number) => Promise<void>
  /**
   * Swap the HARDWARE-scoped per-device state along with the rows: the driver
   * config blob (host/port/credentials/`deviceCache` — everything the
   * provider's schema owns) and the runtime-state blob. Role-scoped keys stay
   * with the number. See `migrate-hardware-state.ts` for the rule, and for
   * the incident where the rows swapped and the configs did not — the two
   * devices came out wearing each other's identity.
   *
   * A failure here THROWS, and the migration throws with it: rows swapped
   * with configs unswapped is exactly that incident, and it must never be
   * reported as a success.
   */
  readonly swapHardwareState: (sourceId: number, targetId: number) => Promise<void>
  /**
   * Refuse a migration over a device under customization
   * (`migrate-hardware-state.ts::assertNoFieldClaims`, D663): a field claim
   * names the NUMBER while its owner names the STABLE ID the swap moves, so no
   * order of operations keeps both right. THROWS to refuse. Asked FIRST —
   * before any switch is flipped, so a refused migration leaves both cameras
   * exactly as they were.
   */
  readonly assertNoFieldClaims: (sourceId: number, targetId: number) => Promise<void>
  /**
   * Tell the stream broker the hardware behind this number is gone
   * (`streamBroker.forgetDeviceHardware`): every DERIVED stream definition is
   * DELETED, the profile-slot assignment entry is purged, and the probed
   * snapshots and RTSP token rows of the old streams go with it.
   *
   * Measured on the live hub after replacing a Hikvision with a Reolink on id
   * 618: the assignment still said `mid → native:slot-3`, a raw slot only the
   * Hikvision had, and the `derived:Mid to low` feeder — defined against the
   * old profile layout — respawned every ten seconds forever (observed at
   * attempt 2732). The recorder reported `no profile attached for device
   * 618`, live view answered `No broker for stream "618/adaptive"`, and no
   * line named the stale assignment as the cause.
   *
   * Forgetting is deliberately what this does, rather than guessing a
   * mapping: the catalog is the authority on which stream is which, and it
   * belongs to the camera that is now there. An RPC, never an event — a
   * dropped event (D8) would leave the feeder respawning forever.
   */
  readonly forgetStreamState: (deviceId: number) => Promise<void>
  readonly log: (message: string, meta: Record<string, unknown>) => void
  /**
   * The state of every switch the camera offers, read BEFORE the disable
   * phase, so a migration refused before any row moved can put each switch
   * back exactly as it was (D663 5b ruling I-1) — never blanket-on, which
   * would undo a function the operator had switched off (D62). Bounded like a
   * switch write; a read that fails is reported and the rollback falls back to
   * switching that camera on.
   */
  readonly readSwitches: (deviceId: number) => Promise<SwitchStates>
  /** One line about ONE device, tagged with its id (D391). */
  readonly logDevice: (
    level: MigrationLogLevel,
    deviceId: number,
    message: string,
    meta: Record<string, unknown>,
  ) => void
  /**
   * Override for {@link SWITCH_WRITE_TIMEOUT_MS}, for the specs. A write that
   * outlives the bound is reported `unreachable` — never `off`/`on` — and may
   * still land later, which every switch authority tolerates (a duplicate
   * write of the same value is a no-op at all eight of them).
   */
  readonly switchTimeoutMs?: number
}

/** A refusal that names a switch the camera does not offer, rather than one it
 *  could not be asked about. The cap documents rejecting the former; anything
 *  else is treated as the camera being out of reach, which is the safe reading:
 *  it keeps the switch in `sourceStillLive` instead of quietly clearing it. */
function classify(err: unknown): { outcome: SwitchOutcome; detail: string } {
  const detail = err instanceof Error ? err.message : String(err)
  const notOffered = /does not offer|not available|unsupported/i.test(detail)
  return { outcome: notOffered ? 'not-offered' : 'unreachable', detail }
}

/**
 * One switch write under the bound. The race, not the write, is what fails on
 * timeout — the underlying promise is marked handled so a late rejection from
 * a camera that eventually answers "no" cannot surface as an unhandled
 * rejection after the migration already reported `unreachable`.
 */
async function setSwitchBounded(
  deps: MigrateDeviceDeps,
  deviceId: number,
  switchId: CameraSwitchId,
  enabled: boolean,
): Promise<void> {
  const budget = deps.switchTimeoutMs ?? SWITCH_WRITE_TIMEOUT_MS
  await withinBudget(
    deps.setSwitch(deviceId, switchId, enabled),
    budget,
    `switch write did not answer within ${budget}ms — reported unreachable; ` +
      'if it lands late, a duplicate write of the same value is a no-op',
  )
}

/** A bounded call: the race fails at `budget`, the late loser is marked handled. */
async function withinBudget<T>(
  call: Promise<T>,
  budget: number,
  timeoutMessage: string,
): Promise<T> {
  call.catch(() => {
    /* handled via the race below; a LATE loser must not become unhandled */
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      call,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(timeoutMessage))
        }, budget)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The prior switch states, or `null` when they could not be read (reported). */
async function readPriorSwitches(
  deps: MigrateDeviceDeps,
  deviceId: number,
): Promise<SwitchStates | null> {
  const budget = deps.switchTimeoutMs ?? SWITCH_WRITE_TIMEOUT_MS
  try {
    return await withinBudget(
      deps.readSwitches(deviceId),
      budget,
      `switch-state read did not answer within ${budget}ms`,
    )
  } catch (err: unknown) {
    deps.logDevice('warn', deviceId, 'migration: prior switch states unreadable', {
      error: err instanceof Error ? err.message : String(err),
      consequence: 'a refusal before the swap would switch this camera fully back on',
    })
    return null
  }
}

/**
 * Put one camera's switches back to what they were before the disable phase.
 * A switch that was off stays off (it still is); one that was on is written
 * on; unknown priors fall back to on — a refusal must not leave a camera dark.
 */
async function restoreSwitches(
  deps: MigrateDeviceDeps,
  deviceId: number,
  prior: SwitchStates | null,
): Promise<readonly SwitchReport[]> {
  const out: SwitchReport[] = []
  for (const switchId of CAMERA_SWITCH_ORDER) {
    if (prior !== null && !prior.has(switchId)) continue
    if (prior !== null && prior.get(switchId) === false) {
      out.push({ deviceId, switchId, outcome: 'off' })
      continue
    }
    try {
      await setSwitchBounded(deps, deviceId, switchId, true)
      out.push({ deviceId, switchId, outcome: 'on' })
    } catch (err) {
      out.push({ deviceId, switchId, ...classify(err) })
    }
  }
  return out
}

/** A refusal before any row moved: both cameras back as they were, then rethrow. */
async function rollBackRefusal(
  deps: MigrateDeviceDeps,
  ids: MigrationIds,
  prior: ReadonlyMap<number, SwitchStates | null>,
  err: MigrationRefusedError,
): Promise<never> {
  for (const deviceId of [ids.sourceId, ids.targetId]) {
    const restored = await restoreSwitches(deps, deviceId, prior.get(deviceId) ?? null)
    deps.logDevice(
      'warn',
      deviceId,
      'migration refused before any row moved — switches restored to their prior state',
      {
        ...ids,
        error: err.message,
        priorKnown: (prior.get(deviceId) ?? null) !== null,
        restored,
        stillOff: restored.filter((r) => r.outcome !== 'on').map((r) => r.switchId),
      },
    )
  }
  throw err
}

/**
 * A failure once rows may have moved. The two devices may wear each other's
 * identity, so nothing is switched back on: both stay off and each device gets
 * an ERROR line saying what moved and that an operator must intervene (D391).
 */
function alarmPartialMigration(
  deps: MigrateDeviceDeps,
  ids: MigrationIds,
  phase: 'swapIds' | 'swapHardwareState',
  err: unknown,
): void {
  const moved =
    phase === 'swapIds'
      ? 'device rows may be PARTIALLY swapped — look for a device at an unfamiliar id'
      : "device rows swapped; driver config / runtime state swap incomplete — the two devices may wear each other's identity"
  for (const deviceId of [ids.sourceId, ids.targetId]) {
    deps.logDevice(
      'error',
      deviceId,
      'migration FAILED after rows began to move — both cameras left switched off; operator must intervene',
      {
        ...ids,
        phase,
        moved,
        error: err instanceof Error ? err.message : String(err),
        remedy:
          'inspect both devices (rows, driver config, runtime state) and repair by hand before switching them back on',
      },
    )
  }
}

async function applyAll(
  deps: MigrateDeviceDeps,
  deviceId: number,
  enabled: boolean,
): Promise<readonly SwitchReport[]> {
  const out: SwitchReport[] = []
  for (const switchId of CAMERA_SWITCH_ORDER) {
    try {
      await setSwitchBounded(deps, deviceId, switchId, enabled)
      out.push({ deviceId, switchId, outcome: enabled ? 'on' : 'off' })
    } catch (err) {
      const { outcome, detail } = classify(err)
      out.push({ deviceId, switchId, outcome, detail })
      // A branch that drops work silently reads as "it never happened".
      deps.log('camera switch refused', { deviceId, switchId, enabled, outcome, detail })
    }
  }
  return out
}

/**
 * Put both cameras to sleep, exchange their identities, wake the target.
 *
 * Throws only if the swap itself fails — a switch that could not be written is
 * reported, not raised, because refusing to migrate a camera whose old hardware
 * is unreachable would refuse the exact case this exists for.
 */
export async function migrateDevice(
  deps: MigrateDeviceDeps,
  input: { readonly sourceId: number; readonly targetId: number },
): Promise<MigrateDeviceResult> {
  const { sourceId, targetId } = input
  if (sourceId === targetId) {
    throw new Error(`[device-manager] migrateDevice: ${sourceId} is both source and target`)
  }

  // A device under customization is not migratable (D663). Before the
  // disable phase: a refusal after it would leave both cameras switched off
  // for a migration that never happens.
  await deps.assertNoFieldClaims(sourceId, targetId)

  // Read before anything is written, so a refusal can restore exactly this.
  const ids: MigrationIds = { sourceId, targetId }
  const prior = new Map<number, SwitchStates | null>([
    [sourceId, await readPriorSwitches(deps, sourceId)],
    [targetId, await readPriorSwitches(deps, targetId)],
  ])

  const down = [
    ...(await applyAll(deps, sourceId, false)),
    ...(await applyAll(deps, targetId, false)),
  ]
  const sourceStillLive = down
    .filter((r) => r.deviceId === sourceId && r.outcome === 'unreachable')
    .map((r) => r.switchId)

  try {
    await deps.swapIds(sourceId, targetId)
  } catch (err: unknown) {
    // Refused with nothing moved: both cameras back exactly as they were.
    if (err instanceof MigrationRefusedError) return rollBackRefusal(deps, ids, prior, err)
    alarmPartialMigration(deps, ids, 'swapIds', err)
    throw err
  }

  // Immediately after the rows, so the window in which the numbers and the
  // configs disagree is as small as the store allows. Never reported as a
  // success and never rolled back: rows swapped with configs unswapped is the
  // incident (two devices wearing each other's identity) — both stay off.
  try {
    await deps.swapHardwareState(sourceId, targetId)
  } catch (err: unknown) {
    alarmPartialMigration(deps, ids, 'swapHardwareState', err)
    throw err
  }

  // BOTH numbers carried broker state describing pre-swap hardware; both are
  // forgotten. Before the switches come back up, so nothing attaches to a
  // stream that is not there — and before the wiring's per-device reload, so
  // the providers' fresh catalog publishes land on a purged assignment map.
  for (const deviceId of [sourceId, targetId]) {
    try {
      await deps.forgetStreamState(deviceId)
    } catch (err) {
      // A branch that drops work silently reads as "it never happened", and
      // this one costs the operator a camera that records nothing while every
      // log line blames something downstream — plus a derived feeder
      // respawning every ten seconds forever.
      deps.log('migration: broker hardware state NOT forgotten — stale stream state survives', {
        deviceId,
        error: err instanceof Error ? err.message : String(err),
        remedy:
          "delete the device's derived streams and reassign its stream profiles, " +
          'or update the stream-broker addon and re-run streamBroker.forgetDeviceHardware',
      })
    }
  }

  // The target is now the INHERITED number: `sourceId` names the new hardware.
  // Flushing the runners' live copies of the two numbers is NOT here: the
  // per-device reload dials back into the device-manager's own write lock, so
  // the wiring runs it after this returns and the lock releases
  // (`migrate-reload.ts`).
  const up = await applyAll(deps, sourceId, true)

  deps.log('camera migrated', {
    sourceId,
    targetId,
    sourceStillLive,
    refusals: [...down, ...up].filter((r) => r.outcome === 'unreachable').length,
  })

  return { sourceId, targetId, switches: [...down, ...up], sourceStillLive, swapped: true }
}
