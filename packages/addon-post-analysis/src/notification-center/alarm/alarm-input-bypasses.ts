/**
 * The alarm INPUTS the operator silenced for the rest of this arm — "Bypass
 * this input until disarm".
 *
 * An input is ONE (rule, device) pair: the rule gated on `armed_*` and the
 * device whose match pressed the panel (the sensor when the match was about
 * one, else the camera — `intrusionDeviceOf`). A false positive that keeps
 * re-triggering the alarm is exactly one such pair; bypassing it leaves every
 * other device of the same rule, and the same device under every other rule,
 * armed.
 *
 * Not an exclusion (`alarm-exclusions.ts`): an exclusion is an opening that was
 * open at ARM time and lifts on its own two-phase edge. A bypass never lifts by
 * itself. It belongs to the arm SESSION and ends with it — on a disarm (any
 * path: the operator, the bridge, the cap, a `disableAfter` auto-disarm) and on
 * a new arm. A bounded siren that RE-ARMS itself is the same session, and the
 * bypass survives it — that re-trigger is the thing it exists to stop.
 *
 * Persisted with the panel's machine, in the panel's own device config, for the
 * exclusions' reason: a deploy in the middle of the night must not quietly hand
 * the false positive back its siren. No second store (D62): this is state of
 * the arm, and it lives where the arm lives.
 */

import { z } from 'zod'

/** At most this many bypassed inputs per arm — a bound on the persisted blob, not a target. */
const NC_ALARM_INPUT_BYPASS_MAX = 200

/** One bypassed input, as persisted. Read back through {@link NcAlarmInputBypasses.restore}. */
const NcAlarmInputBypassRecordSchema = z.object({
  ruleId: z.string().min(1),
  /** The rule's name when it was bypassed — a fallback for the view; the mirror's name wins. */
  ruleName: z.string(),
  /** The INPUT: the sensor of the match, else its camera (`intrusionDeviceOf`). */
  deviceId: z.number().int(),
  /** The match's camera — kept so a rule edit that drops the camera can be recognised. */
  cameraId: z.number().int(),
  /** When the bypass was made. */
  at: z.number(),
  /** Presses dropped since — the count the status shows. */
  dropped: z.number().int().min(0),
})
export type NcAlarmInputBypassRecord = z.infer<typeof NcAlarmInputBypassRecordSchema>

/** What one bypass request did. */
export type NcAlarmInputBypassAddResult = 'bypassed' | 'already-bypassed' | 'full'

/** The pair a bypass is keyed by, plus what the record freezes about it. */
export interface NcAlarmInputBypassRequest {
  readonly ruleId: string
  readonly ruleName: string
  readonly deviceId: number
  readonly cameraId: number
}

export class NcAlarmInputBypasses {
  private entries: readonly NcAlarmInputBypassRecord[] = []

  /** Bypass one input. Idempotent: the same pair twice is one bypass. */
  add(request: NcAlarmInputBypassRequest, at: number): NcAlarmInputBypassAddResult {
    if (this.find(request.ruleId, request.deviceId) !== undefined) return 'already-bypassed'
    if (this.entries.length >= NC_ALARM_INPUT_BYPASS_MAX) return 'full'
    this.entries = [
      ...this.entries,
      {
        ruleId: request.ruleId,
        ruleName: request.ruleName,
        deviceId: request.deviceId,
        cameraId: request.cameraId,
        at,
        dropped: 0,
      },
    ]
    return 'bypassed'
  }

  /** True while this (rule, input) pair must not press the panel. */
  blocks(ruleId: string, deviceId: number): boolean {
    return this.find(ruleId, deviceId) !== undefined
  }

  /** Count one dropped press of a bypassed input; returns the new count, or null when not bypassed. */
  recordDrop(ruleId: string, deviceId: number): number | null {
    const current = this.find(ruleId, deviceId)
    if (current === undefined) return null
    const dropped = current.dropped + 1
    this.entries = this.entries.map((e) => (e === current ? { ...e, dropped } : e))
    return dropped
  }

  /** Every bypassed input, in the order it was bypassed. */
  snapshot(): readonly NcAlarmInputBypassRecord[] {
    return this.entries
  }

  get size(): number {
    return this.entries.length
  }

  /** Drop every bypass — the arm session ended. Returns what was dropped. */
  clear(): readonly NcAlarmInputBypassRecord[] {
    const dropped = this.entries
    this.entries = []
    return dropped
  }

  /** Drop the bypasses `keep` refuses (a rule deleted, disabled or no longer naming the input). */
  prune(keep: (entry: NcAlarmInputBypassRecord) => boolean): readonly NcAlarmInputBypassRecord[] {
    const removed = this.entries.filter((e) => !keep(e))
    if (removed.length > 0) this.entries = this.entries.filter((e) => keep(e))
    return removed
  }

  /**
   * Rebuild from the persisted blob — defensively, per entry: an entry a later
   * release wrote in another shape is dropped, never the whole list. Returns
   * how many entries were dropped so the caller can say so.
   */
  restore(raw: unknown): number {
    if (!Array.isArray(raw)) {
      this.entries = []
      return 0
    }
    const kept: NcAlarmInputBypassRecord[] = []
    let dropped = 0
    for (const item of raw) {
      const parsed = NcAlarmInputBypassRecordSchema.safeParse(item)
      if (!parsed.success || kept.length >= NC_ALARM_INPUT_BYPASS_MAX) {
        dropped += 1
        continue
      }
      if (
        kept.some((e) => e.ruleId === parsed.data.ruleId && e.deviceId === parsed.data.deviceId)
      ) {
        dropped += 1
        continue
      }
      kept.push(parsed.data)
    }
    this.entries = kept
    return dropped
  }

  private find(ruleId: string, deviceId: number): NcAlarmInputBypassRecord | undefined {
    return this.entries.find((e) => e.ruleId === ruleId && e.deviceId === deviceId)
  }
}
