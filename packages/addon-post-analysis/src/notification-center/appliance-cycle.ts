/**
 * What a FINISHED appliance cycle says about itself — the duration and the
 * energy of the run — and the one port the dispatcher reads them through.
 *
 * The facts come from {@link NcResolveApplianceCycleFacts}: ONE named function.
 * In production it reads the durable run record (`appliance-cycle-runs.ts`).
 * Both facts are `null` when unknown (D393): a part that cannot be measured is
 * omitted from the sentence, never printed as `0`, and a failed read never
 * blocks the notification (D49).
 *
 * The texts live in the catalog (`appliance.*`): the scalars `{{duration}}` and
 * `{{energy}}` are rendered from their own keys, then wrapped by the fragments
 * `{{afterDuration}}` / `{{usedEnergy}}`, so each part is re-wordable on its own
 * and a missing part leaves no dangling conjunction (the leading " e " belongs
 * to the energy fragment).
 */

import type { NcTextCatalog } from './text-catalog.js'

export interface NcApplianceCycleFacts {
  /** Milliseconds the cycle ran; `null` when its start is unknown. */
  readonly durationMs: number | null
  /** kWh used over the cycle; `null` when the device has no meter or the read failed. */
  readonly energyKwh: number | null
}

export interface NcApplianceCycleQuery {
  /** The appliance itself (the sensor), never a camera linked to it. */
  readonly deviceId: number
  /** When the cycle finished, epoch ms. */
  readonly finishedAtMs: number
}

/** The ONE lookup of a finished cycle's facts. Never throws a gate: a rejection means "unknown". */
export type NcResolveApplianceCycleFacts = (
  query: NcApplianceCycleQuery,
) => Promise<NcApplianceCycleFacts>

export const NC_UNKNOWN_CYCLE_FACTS: NcApplianceCycleFacts = { durationMs: null, energyKwh: null }

/** The variables a finished-cycle row adds; every key present, empty where unknown. */
export interface NcApplianceCycleVars {
  readonly duration: string
  readonly energy: string
  readonly afterDuration: string
  readonly usedEnergy: string
}

export const NC_EMPTY_CYCLE_VARS: NcApplianceCycleVars = {
  duration: '',
  energy: '',
  afterDuration: '',
  usedEnergy: '',
}

/** `52 minutes` / `1 h 12 min` / `2 h`; `''` below one minute (never "0 minutes"). */
function durationText(texts: NcTextCatalog, durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return ''
  const totalMinutes = Math.round(durationMs / 60_000)
  if (totalMinutes < 1) return ''
  if (totalMinutes < 60) {
    return texts.text({
      key: 'appliance.duration.minutes',
      count: totalMinutes,
      vars: { minutes: `${totalMinutes}` },
    })
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0
    ? texts.text({ key: 'appliance.duration.hours', vars: { hours: `${hours}` } })
    : texts.text({
        key: 'appliance.duration.hoursMinutes',
        vars: { hours: `${hours}`, minutes: `${minutes}` },
      })
}

/** `0,84 kWh` (it) / `0.84 kWh` (en); `''` when unmeasured. */
function energyText(texts: NcTextCatalog, energyKwh: number | null): string {
  if (energyKwh === null || !Number.isFinite(energyKwh) || energyKwh < 0) return ''
  const value = energyKwh.toLocaleString(texts.language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return texts.text({ key: 'appliance.energy.value', vars: { value } })
}

/** The four variables of a finished cycle, fragments rendered from scalars only. */
export function ncApplianceCycleVars(
  texts: NcTextCatalog,
  facts: NcApplianceCycleFacts,
): NcApplianceCycleVars {
  const duration = durationText(texts, facts.durationMs)
  const energy = energyText(texts, facts.energyKwh)
  return {
    duration,
    energy,
    afterDuration:
      duration === '' ? '' : texts.text({ key: 'appliance.finished.duration', vars: { duration } }),
    usedEnergy:
      energy === '' ? '' : texts.text({ key: 'appliance.finished.energy', vars: { energy } }),
  }
}

/**
 * The frozen reference a FINISHED appliance cycle row carries (`{}` for every
 * other row): kind `appliance-cycle`, edge `cleared`. The appliance is the
 * sensor itself — a linked camera is only where the row was attributed.
 */
export function applianceCycleOf(subject: {
  readonly deviceId: number
  readonly sourceDeviceId?: number
  readonly linkedSensorId?: number
  readonly sensorKind?: string
  readonly sensorRaised?: boolean
}): { readonly applianceCycle?: { readonly deviceId: number } } {
  if (subject.sensorKind !== 'appliance-cycle' || subject.sensorRaised !== false) return {}
  return {
    applianceCycle: {
      deviceId: subject.linkedSensorId ?? subject.sourceDeviceId ?? subject.deviceId,
    },
  }
}
