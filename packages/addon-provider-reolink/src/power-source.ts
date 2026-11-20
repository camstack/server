import type { BatteryPowerSourceMode, SwitchPowerSourceResult } from '@apocaliss92/nodelink-js'
import type { ConfigUISchema, IScopedLogger } from '@camstack/types'
import { z } from 'zod'

/**
 * Power source of a battery camera: read it, and switch it between the cell
 * and a wired adapter (cmd 805 SwitchBatteryAdapterMode).
 *
 * A DC-powered battery camera that keeps falling into standby has no setting in
 * the vendor app to change that; the command exists, and this module is the
 * only place that sends it. Two rules shape it:
 *
 *  - A read that FAILED is `unknown`, never `battery`: a camera we could not
 *    ask is not a camera running on its cell (the D393 rule).
 *  - The write is never retried, and it is never claimed. The device answers
 *    "accepted" to a command whose effect we then READ BACK; the report carries
 *    `before` and `after`, and `applied` is true only when `after` is the mode
 *    that was asked for.
 */

export const POWER_SOURCE_MODES = ['adapter', 'battery'] as const
export const PowerSourceModeSchema = z.enum(POWER_SOURCE_MODES)

/** What a read says: a mode, or `unknown` when the read failed or the firmware is silent. */
export const PowerSourceReadingSchema = z.enum(['adapter', 'battery', 'unknown'])
export type PowerSourceReading = z.infer<typeof PowerSourceReadingSchema>

/** The device (or this code) declined before any real write was sent. */
export const PowerSourceRefusalReasonSchema = z.enum(['dry-run-refused', 'dry-run-failed'])
export type PowerSourceRefusalReason = z.infer<typeof PowerSourceRefusalReasonSchema>

export const SwitchPowerSourceResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('refused'),
    mode: PowerSourceModeSchema,
    reason: PowerSourceRefusalReasonSchema,
    before: PowerSourceReadingSchema,
  }),
  z.object({
    outcome: z.literal('sent'),
    mode: PowerSourceModeSchema,
    /** The firmware accepted the command. NOT proof it took effect. */
    accepted: z.boolean(),
    before: PowerSourceReadingSchema,
    after: PowerSourceReadingSchema,
    /** True only when the read-back after the write equals the requested mode. */
    applied: z.boolean(),
  }),
  z.object({
    outcome: z.literal('failed'),
    mode: PowerSourceModeSchema,
    /** The real write threw. It was sent once and is not retried. */
    error: z.string(),
    before: PowerSourceReadingSchema,
  }),
])
export type SwitchPowerSourceOutcome = z.infer<typeof SwitchPowerSourceResultSchema>

/** The slice of the library API this module needs. */
export interface PowerSourceApi {
  getPowerSource(channel?: number): Promise<BatteryPowerSourceMode | undefined>
  probePowerSourceSwitchSupport(
    mode?: BatteryPowerSourceMode,
    options?: { readonly channel?: number },
  ): Promise<boolean>
  switchPowerSource(
    mode: BatteryPowerSourceMode,
    options?: { readonly channel?: number },
  ): Promise<SwitchPowerSourceResult>
}

export interface PowerSourceTarget {
  readonly api: PowerSourceApi
  readonly channel: number
  readonly deviceId: number
  readonly logger: IScopedLogger
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read the power source; a failed or silent read is `unknown`. */
export async function readPowerSource(target: PowerSourceTarget): Promise<PowerSourceReading> {
  const { api, channel, deviceId, logger } = target
  try {
    const mode = await api.getPowerSource(channel)
    if (mode === undefined) {
      logger.info('power source: the firmware does not report it', {
        tags: { deviceId },
        meta: { channel },
      })
      return 'unknown'
    }
    return mode
  } catch (error) {
    logger.warn('power source: read failed, reporting unknown', {
      tags: { deviceId },
      meta: { channel, error: errorMessage(error) },
    })
    return 'unknown'
  }
}

/**
 * Switch the power source: read, dry run, one real write, read back.
 * The write is sent at most once and never retried.
 */
export async function switchPowerSourceTo(
  target: PowerSourceTarget,
  mode: BatteryPowerSourceMode,
): Promise<SwitchPowerSourceOutcome> {
  const { api, channel, deviceId, logger } = target
  const before = await readPowerSource(target)
  logger.info('power source: switch requested', {
    tags: { deviceId },
    meta: { mode, before, channel },
  })

  let supported: boolean
  try {
    supported = await api.probePowerSourceSwitchSupport(mode, { channel })
  } catch (error) {
    logger.warn('power source: dry run failed, no switch sent', {
      tags: { deviceId },
      meta: { mode, error: errorMessage(error) },
    })
    return { outcome: 'refused', mode, reason: 'dry-run-failed', before }
  }
  if (!supported) {
    logger.warn('power source: the device refused the dry run, no switch sent', {
      tags: { deviceId },
      meta: { mode, before },
    })
    return { outcome: 'refused', mode, reason: 'dry-run-refused', before }
  }

  let result: SwitchPowerSourceResult
  try {
    result = await api.switchPowerSource(mode, { channel })
  } catch (error) {
    logger.error('power source: the switch threw; it is not retried', {
      tags: { deviceId },
      meta: { mode, error: errorMessage(error) },
    })
    return { outcome: 'failed', mode, error: errorMessage(error), before }
  }

  const after = await readPowerSource(target)
  const applied = result.accepted && after === mode
  const meta = { mode, before, after, accepted: result.accepted, rspCode: result.rspCode }
  if (applied) {
    logger.info('power source: switched', { tags: { deviceId }, meta })
  } else {
    logger.warn('power source: the switch was sent but the read-back does not show it', {
      tags: { deviceId },
      meta,
    })
  }
  return { outcome: 'sent', mode, accepted: result.accepted, before, after, applied }
}

/** The settings key of the power source: an ordinary select, owned by the camera (never stored). */
export const POWER_SOURCE_SETTING_KEY = 'powerSource'

/**
 * The power source as a setting, in its own section of the Advanced tab.
 * Only a battery camera whose read ANSWERED with a mode has one: a camera that
 * was never asked, or that did not answer, shows nothing rather than a guess.
 */
export function buildPowerSourceSettingsSection(input: {
  readonly isBattery: boolean
  readonly source: PowerSourceReading | undefined
}): readonly ConfigUISchema['sections'][number][] {
  const { isBattery, source } = input
  if (!isBattery || source === undefined || source === 'unknown') return []
  return [
    {
      id: 'power-source',
      tab: 'advanced',
      title: 'Power source',
      titleKey: 'provider-reolink:schema.s_power-source.title',
      description: "Only switch to wired power when the adapter meets the camera's spec.",
      descriptionKey: 'provider-reolink:schema.s_power-source.description',
      columns: 1,
      fields: [
        {
          type: 'select',
          key: POWER_SOURCE_SETTING_KEY,
          label: 'Power source',
          labelKey: 'provider-reolink:schema.s_power-source.powerSource.label',
          default: source,
          required: true,
          options: [
            {
              value: 'adapter',
              label: 'Wired power',
              labelKey: 'provider-reolink:schema.s_power-source.powerSource.o_adapter.label',
            },
            {
              value: 'battery',
              label: 'Battery power',
              labelKey: 'provider-reolink:schema.s_power-source.powerSource.o_battery.label',
            },
          ],
        },
      ],
    },
  ]
}

/**
 * Apply the setting: switch the camera and REFUSE to call a switch that did not
 * land a success — the settings form keeps the operator's edit, marked unsaved.
 */
export async function applyPowerSourceSetting(
  target: PowerSourceTarget,
  value: unknown,
): Promise<void> {
  const mode = PowerSourceModeSchema.safeParse(value)
  if (!mode.success) {
    throw new Error(`Not a power source: ${String(value)}`)
  }
  const outcome = await switchPowerSourceTo(target, mode.data)
  if (outcome.outcome === 'refused') {
    throw new Error(`The camera refused the power source switch (${outcome.reason})`)
  }
  if (outcome.outcome === 'failed') {
    throw new Error(`The power source switch failed: ${outcome.error}`)
  }
  if (!outcome.applied) {
    throw new Error(`The camera did not take the power source switch (it reports ${outcome.after})`)
  }
}
