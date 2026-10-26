/**
 * `NcDeviceAlerts` — the one place a SUSTAINED device fault becomes a
 * notification, and keeps becoming one until it stops being true.
 *
 * It owns these families and nothing else:
 *
 *  - **battery band** — `battery:<deviceId>`, fed by the `battery` runtime-state
 *    slice that already arrives on `device.state-changed`;
 *  - **consumable band** — `consumable@<threshold>:<deviceId>:<key>`, one
 *    episode per item per threshold a RULE asks for (D642);
 *  - **provider consumable** — `consumable:<deviceId>:<key>`, a supply / waste
 *    item judged on the provider's own verdict (D934);
 *  - **the reminder tick** — the operator's "how often do you say it again".
 *
 * It does NOT own device liveness. `device-offline` already has a producer, a
 * 5-minute trailing hold-off and a durable ledger of its own
 * (`liveness-holdoff.ts`, `liveness-ledger.ts`), and a second authority over
 * the same fact is the shape D62 forbids. What this class adds to liveness is
 * the REMINDER, through the same row type — see {@link observeLiveness}.
 *
 * ## Everything goes through `emit`, and `emit` is `consumeEvent`
 *
 * A reminder is not a second delivery path. It re-enters the centre through the
 * one door every producer uses, so the per-camera mute, the snooze, the rule
 * conditions and the rule's own schedule all still apply to it. A reminder that
 * bypassed them would arrive at 03:00 in a household that had said not to.
 *
 * ## The row is durable, the verdict is derived
 *
 * `rows` is a port on purpose: production hands it a `DurableLedger`, a spec
 * hands it a Map. The alternative — this class knowing about SQLite — is what
 * made `NcLivenessLedger` a mechanism as well as a policy until the 2026-08-13
 * census pulled the two apart.
 *
 * D49's failure direction, unchanged: a cold `rows` port SEEDS, i.e. fails
 * toward silence for a healthy device. The one exception is a first observation
 * that is already a FAULT — see `alert-episode.ts` rule 2 for why that is D141
 * rather than a loophole.
 */

import { deriveConsumableBand } from './consumable-band.js'
import { EventCategory, type IScopedLogger } from '@camstack/types'
import type { NcDeviceIdentity } from '../device-directory.js'
import {
  isProviderVerdictDetail,
  type NcOpenAlert,
  isBatterySubject,
  openAlertOf,
  providerVerdictDetail,
} from './open-alert.js'
import {
  incomingFromBatteryBand,
  incomingFromConsumableBand,
  incomingFromProviderConsumableBand,
  type NcConsumableItemReading,
  type NcIncomingEvent,
  type NcProviderConsumableAttention,
  type NcSystemEventFacts,
} from '../event-intake.js'
import type { NcConsumableSliceItem } from './consumable-routing.js'
import {
  consumableSubject,
  legacyConsumableSubject,
  parseConsumableSubject,
} from './consumable-subject.js'
import {
  deriveSupplyBand,
  NC_SUPPLY_HOLD_MS,
  type NcSupplyBand,
  type NcSupplyReading,
} from './supply-band.js'
import {
  alertRecordId,
  alertSubjectDeviceId,
  decideAlert,
  type NcAlertRow,
  type NcAlertVerdict,
  nextAlertRow,
  withAlertDetail,
} from './alert-episode.js'
import { deriveBatteryBand, type NcBatteryBand, type NcBatteryReading } from './battery-band.js'
import { tankSubject } from './tank-subject.js'

/**
 * The THREE cluster settings, and no fourth (the operator's D-2 and D-4).
 *
 * The consumable threshold is NOT one of them any more (D642): it is each
 * rule's `systemEvent.consumableLowPercent`, read through
 * {@link NcDeviceAlertsDeps.consumableThresholds}.
 */
export interface NcDeviceAlertSettings {
  /** At or below this, a MEASURED battery is low. Binary sources ignore it. */
  readonly batteryLowPercent: number
  /** How often a still-true alert is said again. **0 = say it once.** */
  readonly renotifyMinutes: number
  /** Announce the return to normal / back online. Defaults on. */
  readonly notifyRecovery: boolean
}

/** The durable row store, as the only thing this class needs from one. */
export interface NcAlertRowPort {
  readonly get: (subject: string) => NcAlertRow | undefined
  readonly put: (row: NcAlertRow) => void
  readonly all: () => readonly NcAlertRow[]
  /** Drop one subject, mirror and durable row (a deleted device). */
  readonly remove: (subject: string) => Promise<void>
  /**
   * Has the durable store been READ once (D647)? Absent = a port that is
   * always the truth (a spec's Map). `false` makes {@link
   * NcDeviceAlerts.openEpisodes} answer `null`: an unread ledger is not
   * "nothing is low".
   */
  readonly answered?: () => boolean
}

/**
 * The ONE door, and its answer: did ANY rule match this event?
 *
 * `true` is "someone was told" (or deliberately held back by a rule's own
 * cooldown); `false` is "no rule matched", which leaves a raise PENDING. An
 * answer that never arrives (the promise rejects) is treated as `true` — the
 * pre-D636 behaviour — because re-raising on a failed read is the flood
 * direction, and the one this class was built to avoid.
 */
export type NcAlertEmit = (event: NcIncomingEvent) => Promise<boolean>

export interface NcDeviceAlertsDeps {
  /** `NotificationCenter.consumeEventAndReport` in production — see {@link NcAlertEmit}. */
  readonly emit: NcAlertEmit
  /**
   * A fingerprint of the rule set. A PENDING raise (no rule matched it) is
   * retried on the tick only when this changed since its last attempt: the fix
   * for an undelivered alert is always an edit to a rule, and re-evaluating
   * the same rules against the same episode every tick would say nothing new.
   */
  readonly rulesVersion: () => string
  /**
   * Every consumable threshold the rule set asks for (D642) —
   * `consumableThresholdCensus` over the RAM rule mirror in production. `null`
   * while the rules have not been read: then no item is judged and no row is
   * touched (D49 — a read that has not answered changes nothing); the reading
   * is kept and judged on the first tick that has an answer.
   */
  readonly consumableThresholds: () => readonly number[] | null
  readonly settings: () => NcDeviceAlertSettings
  readonly lookup: (deviceId: number) => NcDeviceIdentity | undefined
  readonly rows: NcAlertRowPort
  readonly now?: () => number
  readonly logger?: IScopedLogger
}

/** What a still-open episode needs to be re-said. */
interface AlertRestatement {
  readonly deviceId: number
  readonly band: NcBatteryBand
  readonly reading: NcBatteryReading
}

/** When a pending raise was last offered, and to which rule set. */
interface NcAlertOffer {
  readonly version: string
  readonly at: number
}

/** One hour — the longest a pending raise waits before it is offered again. */
const PENDING_CADENCE_MAX_MS = 3_600_000

/**
 * How often a pending raise is offered again with the rules unchanged: the
 * re-notify interval, capped at one hour. The cap matters because the
 * cadence counts from the raise: with a 12 h interval, a rule whose schedule
 * opens for one hour a day could keep being missed. Reminders off ("say it
 * once") still has to say it once, hourly.
 */
function pendingCadenceMs(settings: NcDeviceAlertSettings): number {
  return settings.renotifyMinutes > 0
    ? Math.min(settings.renotifyMinutes * 60_000, PENDING_CADENCE_MAX_MS)
    : PENDING_CADENCE_MAX_MS
}

/** Words one alert for the door, from the facts of THIS emission. */
type NcAlertBuild = (facts: NcSystemEventFacts) => NcIncomingEvent

/** The same, for one consumable item. */
interface ConsumableRestatement {
  readonly deviceId: number
  readonly item: NcConsumableItemReading
}

/** The same, for one provider-judged item. */
interface ProviderRestatement {
  readonly deviceId: number
  readonly item: NcConsumableSliceItem
  readonly attention: NcProviderConsumableAttention
}

/** A provider verdict change seen but not yet held long enough to count (review M2). */
interface HeldSupplyChange {
  readonly band: NcSupplyBand
  readonly since: number
}

/** The RAM key of one item's last reading — every threshold's episode reads it. */
function itemKeyOf(deviceId: number, key: string): string {
  return `${String(deviceId)}:${key}`
}

export class NcDeviceAlerts {
  private readonly now: () => number
  /**
   * The last reading of each battery subject, so a REMINDER can re-word the
   * sentence with the number the device actually reports rather than the one it
   * reported when the episode opened. RAM only: losing it costs a reminder's
   * percentage and nothing else, and the row that decides WHETHER to remind is
   * durable.
   */
  private readonly lastReading = new Map<string, AlertRestatement>()
  /**
   * The last reading per consumable ITEM (`<deviceId>:<key>`), for the
   * reminder sweep and for judging a threshold a rule gains later (D642).
   */
  private readonly lastConsumable = new Map<string, ConsumableRestatement>()
  /** Provider-judged items, keyed by episode subject (`consumable:<id>:<key>`). */
  private readonly lastProvider = new Map<string, ProviderRestatement>()
  /**
   * Provider consumable changes on HOLD (review M2): a band that would move the
   * episode, first seen at `since`. It counts once it has held for
   * `NC_SUPPLY_HOLD_MS`, confirmed by a later slice write or by the reload tick
   * — no timer of its own, so nothing outlives the device. Bounded by the
   * device's supply/waste items, and dropped with the device by {@link forget}.
   */
  private readonly supplyHold = new Map<string, HeldSupplyChange>()
  /**
   * Thresholds some episode row carries that the LAST census did not ask for.
   * A threshold's rows are retired only when two consecutive censuses agree it
   * is gone (D49: a read that would destroy work needs a second read to
   * agree). RAM only: a restart costs one more tick of patience.
   */
  private absentThresholds: ReadonlySet<number> = new Set()
  /**
   * Subject → WHEN its PENDING raise was last offered, and to which
   * {@link NcDeviceAlertsDeps.rulesVersion}. RAM only, on purpose: after a
   * restart every pending raise is offered once more, which is bounded by the
   * number of open episodes.
   */
  private readonly offeredAt = new Map<string, NcAlertOffer>()

  constructor(private readonly deps: NcDeviceAlertsDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * One `battery` runtime-state slice.
   *
   * A reading the device has never actually taken leaves EVERYTHING untouched —
   * no row, no emission, no seed. Seeding it as healthy would be a claim, and
   * the next genuine reading of 4 % would then look like a transition out of a
   * state nobody observed. Three devices on this hub are in exactly that
   * position.
   */
  observeBattery(deviceId: number, reading: NcBatteryReading): void {
    const subject = `battery:${deviceId}`
    const previous = this.deps.rows.get(subject)
    const settings = this.deps.settings()
    const band = deriveBatteryBand({
      reading,
      thresholdPercent: settings.batteryLowPercent,
      previous: previous?.alerting === true ? 'low' : previous === undefined ? undefined : 'normal',
    })
    if (band === null) return
    this.lastReading.set(subject, { deviceId, band, reading })
    this.apply(subject, band === 'low', settings, (facts, alerting) =>
      incomingFromBatteryBand({
        facts,
        deviceId,
        band: alerting ? 'low' : 'normal',
        reading,
        identity: this.deps.lookup(deviceId),
      }),
    )
  }

  /**
   * ONE consumable item, from a device's `consumables` slice.
   *
   * Per ITEM, never per device: a vacuum has a brush, a filter and a mop pad,
   * and folding them into one subject would make the brush's alert cancel the
   * filter's — the same collision D141 split `device-switch:<id>` off liveness
   * to avoid. Each item is its own episode, its own cooldown, its own recovery.
   *
   * An item that has told us nothing leaves EVERYTHING untouched, for the
   * reason `observeBattery` does: seeding it healthy is a claim, and the first
   * genuine `replace` would then read as a transition out of a state nobody
   * observed.
   */
  /** One item from the consumables slice — every form (D934). */
  observeConsumableItem(deviceId: number, sliceItem: NcConsumableSliceItem): void {
    this.closeTankLeftover(deviceId, sliceItem.key)
    if (sliceItem.wear !== null) {
      this.observeConsumable(deviceId, sliceItem.wear)
      return
    }
    this.observeProviderConsumable(deviceId, sliceItem)
  }

  observeConsumable(deviceId: number, item: NcConsumableItemReading): void {
    this.lastConsumable.set(itemKeyOf(deviceId, item.key), { deviceId, item })
    const thresholds = this.deps.consumableThresholds()
    if (thresholds === null) {
      // Kept, not dropped: the first tick that can read the rules judges it.
      this.logger()?.debug('consumable reading kept — the rules have not been read yet', {
        tags: { deviceId },
        meta: { item: item.key },
      })
      return
    }
    const settings = this.deps.settings()
    for (const thresholdPercent of thresholds) {
      this.judgeConsumable(deviceId, item, thresholdPercent, settings)
    }
  }

  /** A supply / waste item — provider verdict only (D934). */
  private observeProviderConsumable(deviceId: number, sliceItem: NcConsumableSliceItem): void {
    const reading = providerSupplyReading(sliceItem)
    const band = deriveSupplyBand(reading)
    if (band === null) return
    const subject = legacyConsumableSubject(deviceId, sliceItem.key)
    const attention: NcProviderConsumableAttention = band === 'full' ? 'full' : 'low'
    this.lastProvider.set(subject, { deviceId, item: sliceItem, attention })
    if (!this.supplyChangeHeld(subject, deviceId, band)) return
    this.apply(
      subject,
      band !== 'normal',
      this.deps.settings(),
      (facts, alerting) =>
        incomingFromProviderConsumableBand({
          facts,
          deviceId,
          band: alerting ? 'low' : 'normal',
          item: { key: sliceItem.key, label: sliceItem.label, form: sliceItem.form },
          attention,
          identity: this.deps.lookup(deviceId),
        }),
      band === 'normal' ? undefined : providerVerdictDetail(band, sliceItem.form),
    )
  }

  /**
   * Has this provider band held long enough to move its episode? A band that
   * would not move it (a repeat, or low ⇄ full inside one open episode) passes
   * at once and clears any hold — that is what makes a flapping switch start
   * its hold over every time it flips back. A first HEALTHY observation passes
   * too: it seeds silently, so there is nothing to hold.
   */
  private supplyChangeHeld(subject: string, deviceId: number, band: NcSupplyBand): boolean {
    const row = this.deps.rows.get(subject)
    const alerting = band !== 'normal'
    const moves = row === undefined ? alerting : row.alerting !== alerting
    if (!moves) {
      this.supplyHold.delete(subject)
      return true
    }
    const nowMs = this.now()
    const held = this.supplyHold.get(subject)
    if (held === undefined || held.band !== band) {
      this.supplyHold.set(subject, { band, since: nowMs })
      this.logger()?.debug('provider consumable change on hold — counts once it has held', {
        tags: { deviceId },
        meta: { subject, band, holdMs: NC_SUPPLY_HOLD_MS },
      })
      return false
    }
    if (nowMs - held.since < NC_SUPPLY_HOLD_MS) return false
    this.supplyHold.delete(subject)
    return true
  }

  /** The tick's half of the hold: a change that has held with no new slice write. */
  private confirmHeldSupply(): void {
    const nowMs = this.now()
    for (const [subject, held] of [...this.supplyHold]) {
      if (nowMs - held.since < NC_SUPPLY_HOLD_MS) continue
      const reading = this.lastProvider.get(subject)
      if (reading === undefined) {
        this.supplyHold.delete(subject)
        continue
      }
      this.observeProviderConsumable(reading.deviceId, reading.item)
    }
  }

  /** One item against ONE threshold: its own episode, its own hysteresis. */
  private judgeConsumable(
    deviceId: number,
    item: NcConsumableItemReading,
    thresholdPercent: number,
    settings: NcDeviceAlertSettings,
  ): void {
    const subject = consumableSubject(thresholdPercent, deviceId, item.key)
    const previous = this.deps.rows.get(subject) ?? this.adoptLegacy(subject, deviceId, item.key)
    const band = deriveConsumableBand({
      reading: { level: item.level, status: item.status },
      thresholdPercent,
      previous: previous?.alerting === true ? 'low' : previous === undefined ? undefined : 'normal',
    })
    if (band === null) return
    this.apply(subject, band === 'low', settings, (facts, alerting) =>
      incomingFromConsumableBand({
        facts,
        deviceId,
        band: alerting ? 'low' : 'normal',
        item,
        thresholdPercent,
        identity: this.deps.lookup(deviceId),
      }),
    )
  }

  /**
   * A pre-D642 row of this item (`consumable:<id>:<key>`, judged at the
   * cluster threshold, which shipped as the rule default) is carried over to
   * the default-threshold episode rather than re-announced: the live vacuum
   * had two items low and reminding when D642 shipped. Any other threshold
   * starts fresh; an unadopted legacy row retires with the census.
   */
  private adoptLegacy(subject: string, deviceId: number, key: string): NcAlertRow | undefined {
    const parts = parseConsumableSubject(subject)
    const legacySubject = legacyConsumableSubject(deviceId, key)
    const legacy = this.deps.rows.get(legacySubject)
    if (legacy === undefined || parts === null) return undefined
    const legacyParts = parseConsumableSubject(legacySubject)
    if (legacyParts === null || legacyParts.thresholdPercent !== parts.thresholdPercent) {
      return undefined
    }
    const adopted: NcAlertRow = { ...legacy, subject }
    this.deps.rows.put(adopted)
    this.dropRow(legacySubject, 'carried over to its threshold episode (D642)')
    return adopted
  }

  /**
   * The reminder sweep. Called from an existing periodic tick; it allocates
   * nothing on the healthy path.
   *
   * It re-says only what is STILL true — the row is the authority, and the row
   * moved when the condition did. A tick that re-derived the condition here
   * would be a second reading of the same fact, free to disagree with the one
   * the ledger holds.
   */
  tick(): void {
    const settings = this.deps.settings()
    const thresholds = this.deps.consumableThresholds()
    if (thresholds !== null) this.reconcileThresholds(thresholds, settings)
    this.confirmHeldSupply()
    // PENDING raises first, and whatever the reminder setting says: the first
    // notice of an episode is not a reminder, and `renotifyMinutes = 0` means
    // "say it once" — not "say it never".
    this.retryPending(settings)
    if (settings.renotifyMinutes <= 0) return
    for (const row of this.deps.rows.all()) {
      if (!row.alerting || isPending(row)) continue
      const build = this.restatementOf(row.subject)
      if (build === null) continue
      // Re-says only what is STILL true: the row is the authority, and it
      // moved when the condition did.
      this.apply(row.subject, true, settings, build)
    }
  }

  /**
   * Every OPEN episode, restated (D647). `null` while the rows have not been
   * read. A legacy consumable row is skipped (it is adopted or retired first),
   * and so is a provider item whose band is unknown and whose device the
   * summary could not word — never silently: each skip is a line.
   */
  openEpisodes(): readonly NcOpenAlert[] | null {
    if (this.deps.rows.answered?.() === false) return null
    const facts: NcSystemEventFacts = {
      eventId: 'state-summary',
      timestamp: this.now(),
      category: 'state-summary',
      data: {},
    }
    const out: NcOpenAlert[] = []
    for (const row of this.deps.rows.all()) {
      if (!row.alerting) continue
      const restated = this.restatementOf(row.subject)
      const logger = this.logger()
      const open = openAlertOf(row, {
        facts,
        restated: restated === null ? null : restated(facts),
        lookup: this.deps.lookup,
        ...(logger !== undefined ? { logger } : {}),
      })
      if (open !== null) out.push(open)
      else if (parseConsumableSubject(row.subject) !== null || isBatterySubject(row.subject)) {
        this.logger()?.debug('open alert left out of the state summary — it cannot be worded', {
          ...tagsOf(row.subject),
          meta: { subject: row.subject },
        })
      }
    }
    return out
  }

  /**
   * Every device that holds an alert row — what the deleted-device reconcile
   * must look at besides the devices a rule names (a battery device no rule
   * names still has a row).
   */
  deviceIds(): readonly number[] {
    const ids = new Set<number>()
    for (const row of this.deps.rows.all()) {
      const id = alertSubjectDeviceId(row.subject)
      if (id !== undefined) ids.add(id)
    }
    return [...ids]
  }

  /**
   * A DELETED device: drop its battery row and every consumable row, durable
   * and in RAM, so nothing restates it and a re-adoption starts a fresh
   * episode. Called only by the deleted-device prune (D633), after the second
   * read agreed the device is gone. Returns how many rows went.
   */
  async forget(deviceId: number): Promise<number> {
    const subjects = this.deps.rows
      .all()
      .map((row) => row.subject)
      .filter((subject) => alertSubjectDeviceId(subject) === deviceId)
    for (const subject of subjects) {
      this.lastReading.delete(subject)
      this.lastProvider.delete(subject)
      this.offeredAt.delete(subject)
      await this.deps.rows.remove(subject)
    }
    // RAM restatements of a device that never got a row (a never-measured
    // reading is not stored) go too — and every item reading of the device,
    // which no row names by its RAM key.
    this.lastReading.delete(`battery:${deviceId}`)
    for (const [key, reading] of this.lastConsumable) {
      if (reading.deviceId === deviceId) this.lastConsumable.delete(key)
    }
    for (const subject of this.supplyHold.keys()) {
      if (alertSubjectDeviceId(subject) === deviceId) this.supplyHold.delete(subject)
    }
    for (const subject of this.lastProvider.keys()) {
      if (alertSubjectDeviceId(subject) === deviceId) this.lastProvider.delete(subject)
    }
    return subjects.length
  }

  /**
   * Bring the consumable episodes in line with the thresholds the rules ask
   * for (D642). A threshold with no episode for an item yet is judged from the
   * item's last reading — a rule that gains a threshold hears about an item
   * already past it on the next tick, not at the next slice write. A
   * threshold that no rule asks for any more has its episodes RETIRED, but
   * only when two consecutive censuses agree it is gone; retiring is silent
   * (nothing recovered — nobody is listening at that number any more) and
   * logged per row.
   */
  private reconcileThresholds(
    thresholds: readonly number[],
    settings: NcDeviceAlertSettings,
  ): void {
    for (const { deviceId, item } of this.lastConsumable.values()) {
      for (const thresholdPercent of thresholds) {
        if (this.deps.rows.get(consumableSubject(thresholdPercent, deviceId, item.key))) continue
        this.judgeConsumable(deviceId, item, thresholdPercent, settings)
      }
    }
    const absent = new Set<number>()
    for (const row of this.deps.rows.all()) {
      const parts = parseConsumableSubject(row.subject)
      if (parts === null || thresholds.includes(parts.thresholdPercent)) continue
      // A provider-verdict item lives on the legacy subject and carries no
      // threshold (D934). The parsed "15" is the pre-D642 default, not a rule
      // this row was judged at — retiring it drops salt and rinse aid whenever
      // every consumable rule asks for some other number.
      if (parts.legacy && isProviderVerdictDetail(row.detail)) continue
      absent.add(parts.thresholdPercent)
      if (this.absentThresholds.has(parts.thresholdPercent)) {
        this.dropRow(row.subject, 'retired — no rule judges consumables at this threshold (D642)')
      }
    }
    this.absentThresholds = absent
  }

  /**
   * A leftover `tank:<id>:<key>` ends when that key is seen on the consumables
   * slice (D934). Silent: no recovery. A real `battery:` row is a different
   * subject and is not touched.
   */
  private closeTankLeftover(deviceId: number, key: string): void {
    const subject = tankSubject(deviceId, key)
    if (this.deps.rows.get(subject) === undefined) return
    this.dropRow(subject, 'closed — the same key is a consumable (D934)')
  }

  /** Remove one row, mirror and durable, with a line that names why. */
  private dropRow(subject: string, reason: string): void {
    this.offeredAt.delete(subject)
    this.logger()?.info(`device alert ${reason}`, { ...tagsOf(subject), meta: { subject } })
    this.deps.rows.remove(subject).catch((error: unknown) => {
      this.logger()?.warn('device alert row could not be removed', {
        ...tagsOf(subject),
        meta: { subject, error: error instanceof Error ? error.message : String(error) },
      })
    })
  }

  /**
   * Offer every PENDING raise once more — when the rule set changed since its
   * last offer, OR when {@link pendingCadenceMs} has passed since it. The
   * cadence is what delivers a raise refused only by a rule's SCHEDULE (or any
   * other time-dependent gate): the rules do not change when the window
   * opens. The restatement is RAM: a row whose reading has not arrived since
   * the restart waits for it (the slice arrives on its own).
   */
  private retryPending(settings: NcDeviceAlertSettings): void {
    const version = this.deps.rulesVersion()
    const nowMs = this.now()
    const cadenceMs = pendingCadenceMs(settings)
    for (const row of this.deps.rows.all()) {
      if (!isPending(row)) continue
      const last = this.offeredAt.get(row.subject)
      const changed = last === undefined || last.version !== version
      if (!changed && nowMs - last.at < cadenceMs) continue
      const build = this.restatementOf(row.subject)
      if (build === null) continue
      this.logger()?.debug('device alert re-offered — no rule has matched it yet', {
        ...tagsOf(row.subject),
        meta: { subject: row.subject, since: row.since, reason: changed ? 'rules' : 'cadence' },
      })
      this.speak(row.subject, row, { kind: 'raise' }, build)
    }
  }

  /** How to re-word a subject's alert from the last reading, or `null`. */
  private restatementOf(subject: string): NcAlertBuild | null {
    const parts = parseConsumableSubject(subject)
    if (parts !== null && parts.legacy) {
      const provider = this.lastProvider.get(subject)
      if (provider !== undefined) {
        return (facts) =>
          incomingFromProviderConsumableBand({
            facts,
            deviceId: provider.deviceId,
            band: 'low',
            item: {
              key: provider.item.key,
              label: provider.item.label,
              form: provider.item.form,
            },
            attention: provider.attention,
            identity: this.deps.lookup(provider.deviceId),
          })
      }
    }
    const consumable =
      parts === null || parts.legacy
        ? undefined
        : this.lastConsumable.get(itemKeyOf(parts.deviceId, parts.key))
    if (parts !== null && !parts.legacy && consumable !== undefined) {
      return (facts) =>
        incomingFromConsumableBand({
          facts,
          deviceId: consumable.deviceId,
          band: 'low',
          item: consumable.item,
          thresholdPercent: parts.thresholdPercent,
          identity: this.deps.lookup(consumable.deviceId),
        })
    }
    const battery = this.lastReading.get(subject)
    if (battery !== undefined) {
      return (facts) =>
        incomingFromBatteryBand({
          facts,
          deviceId: battery.deviceId,
          band: 'low',
          reading: battery.reading,
          identity: this.deps.lookup(battery.deviceId),
        })
    }
    return null
  }

  /**
   * The shared half: decide, persist, and speak only when the verdict says to.
   *
   * The row is written for EVERY verdict including the suppressed recovery —
   * a state we never recorded leaving is a state we can never announce
   * entering again.
   */
  private apply(
    subject: string,
    alerting: boolean,
    settings: NcDeviceAlertSettings,
    build: (facts: NcSystemEventFacts, alerting: boolean) => NcIncomingEvent,
    detail?: string,
  ): void {
    const nowMs = this.now()
    const previous = this.deps.rows.get(subject)
    const verdict = decideAlert({
      previous,
      alerting,
      nowMs,
      renotifyMs: settings.renotifyMinutes * 60_000,
      notifyRecovery: settings.notifyRecovery,
    })
    const next = withAlertDetail(
      nextAlertRow(subject, previous, alerting, verdict, nowMs),
      alerting ? (detail ?? previous?.detail) : undefined,
    )
    if (next !== previous) this.deps.rows.put(next)
    if (!speaks(verdict)) {
      this.report(subject, verdict, alerting)
      return
    }
    this.speak(subject, next, verdict, (facts) => build(facts, alerting))
  }

  /**
   * Emit one verdict through the door, and — for a RAISE — hear whether any
   * rule matched it. A raise no rule matched is put back to PENDING
   * (`lastNotifiedAt: 0`), unless the row moved meanwhile; it is re-offered
   * by {@link retryPending} when the rules change. A reminder or a recovery is
   * not re-offered: the episode was already announced (or is over).
   */
  private speak(
    subject: string,
    row: NcAlertRow,
    verdict: NcAlertVerdict,
    build: NcAlertBuild,
  ): void {
    const nowMs = this.now()
    const reminderIndex = verdict.kind === 'remind' ? verdict.reminderIndex : 0
    const event = build({
      // The record id IS the outbox dedup ref (it falls back to
      // `subject.recordId`), so a reminder must carry its own or the 7-day
      // dedup swallows it. See `alert-episode.ts` rule 4. A re-offered raise
      // keeps the RAISE's id, so a rule that already delivered it is deduped.
      eventId: alertRecordId(subject, row.since, reminderIndex),
      timestamp: nowMs,
      // The category the observation ORIGINATED from, carried for the log
      // line only — nothing is emitted on the bus here. A reminder has no
      // bus event behind it at all, and naming the origin is more useful
      // than inventing a category for the tick. Same seam the alarm panel
      // uses: `NcSystemEventFacts` exists precisely so a system subject can
      // be built without a synthetic `SystemEvent` pretending to have come
      // off the bus.
      category: EventCategory.DeviceStateChanged,
      data: { alertVerdict: verdict.kind, reminderIndex },
    })
    if (verdict.kind !== 'raise') {
      void this.deps.emit(event).catch(() => undefined)
      return
    }
    this.offeredAt.set(subject, { version: this.deps.rulesVersion(), at: nowMs })
    void this.deps
      .emit(event)
      .then((heard) => this.settleRaise(subject, row.since, heard, nowMs))
      .catch(() => undefined)
  }

  /** The door answered a raise. */
  private settleRaise(subject: string, since: number, heard: boolean, nowMs: number): void {
    const current = this.deps.rows.get(subject)
    // The row moved on (a recovery, a new episode) while the door was
    // deciding: that later write is the authority, not this answer.
    if (current === undefined || !current.alerting || current.since !== since) return
    if (heard) {
      this.offeredAt.delete(subject)
      if (current.lastNotifiedAt !== nowMs)
        this.deps.rows.put({ ...current, lastNotifiedAt: nowMs })
      return
    }
    if (current.lastNotifiedAt !== 0) this.deps.rows.put({ ...current, lastNotifiedAt: 0 })
    this.logger()?.info(
      'device alert matched NO rule — kept pending, offered again on a rule change or within the hour',
      {
        ...tagsOf(subject),
        meta: { subject, since },
      },
    )
  }

  private logger(): IScopedLogger | undefined {
    return this.deps.logger
  }

  /**
   * A dropped branch is never silent. The suppressed recovery in particular:
   * it is a notification the operator will not receive, and the only honest
   * place to say so is the log.
   */
  private report(subject: string, verdict: NcAlertVerdict, alerting: boolean): void {
    const logger = this.deps.logger
    if (logger === undefined) return
    if (verdict.kind === 'silent' && !alerting) {
      logger.debug('device alert cleared without a notification', {
        ...tagsOf(subject),
        meta: { subject, reason: 'notifyRecovery is off, or nothing changed' },
      })
      return
    }
    logger.debug('device alert said nothing', {
      ...tagsOf(subject),
      meta: { subject, verdict: verdict.kind },
    })
  }
}

function speaks(verdict: NcAlertVerdict): boolean {
  return verdict.kind === 'raise' || verdict.kind === 'recover' || verdict.kind === 'remind'
}

/**
 * A raise no rule matched: alerting, and never announced. A row in the
 * alerting state is otherwise always stamped, because it was raised.
 */
function isPending(row: NcAlertRow): boolean {
  return row.alerting && row.lastNotifiedAt <= 0
}

/** The `tags` half of an alert log line — `{ deviceId }` when the subject names one. */
interface NcAlertLogTags {
  readonly tags?: { readonly deviceId: number }
}

function tagsOf(subject: string): NcAlertLogTags {
  const deviceId = alertSubjectDeviceId(subject)
  return deviceId !== undefined ? { tags: { deviceId } } : {}
}

function providerSupplyReading(item: NcConsumableSliceItem): NcSupplyReading {
  const base: NcSupplyReading = {
    key: item.key,
    label: item.label,
    level: item.level,
    status: null,
  }
  const status = item.status
  if (item.kind === 'supply') {
    switch (status) {
      case 'low':
      case 'empty':
      case 'replace':
        return { ...base, status: 'low' }
      case 'ok':
      case 'full':
        return { ...base, status: 'ok' }
      default:
        return base
    }
  }
  if (item.kind === 'waste') {
    switch (status) {
      case 'full':
      case 'replace':
        return { ...base, status: 'full' }
      case 'ok':
      case 'low':
      case 'empty':
        return { ...base, status: 'ok' }
      default:
        return base
    }
  }
  return base
}
