import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { IrTimingsSchema, TransmitSettingsSchema } from '../ir/ir-timings.js'
import { IrNativeCodeSchema, IrNativeFormatSchema } from '../ir/native.js'
import { readErrorI18n } from '../i18n/camstack-error.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/** The setting keys a transmitter may declare as settable (`getInfo.settable`). */
export const TransmitSettingKeySchema = z.enum([
  'carrierHz',
  'dutyCyclePercent',
  'repeat',
  'repeatDelayMs',
])
export type TransmitSettingKey = z.infer<typeof TransmitSettingKeySchema>

export const IrMediumSchema = z.enum(['ir', 'rf'])
export type IrMedium = z.infer<typeof IrMediumSchema>

export const IrSendResultSchema = z.object({
  ok: z.literal(true),
  /** Settings the transmitter could not apply; the train was still sent. */
  ignoredSettings: z.array(z.string()),
})
export type IrSendResult = z.infer<typeof IrSendResultSchema>

export const IrTransmitterInfoSchema = z.object({
  media: z.array(IrMediumSchema),
  settable: z.array(TransmitSettingKeySchema),
  maxTimings: z.number().int().positive(),
  /** The transmitter can learn a code (`learn`). */
  learn: z.boolean().default(false),
  /** Native code formats the transmitter replays verbatim (`send.native`). */
  formats: z.array(IrNativeFormatSchema).default([]),
})
export type IrTransmitterInfo = z.infer<typeof IrTransmitterInfoSchema>

export const IR_LEARN_TIMEOUT_DEFAULT_MS = 20_000
export const IR_LEARN_TIMEOUT_MAX_MS = 60_000

export const IrLearnResultSchema = z.object({
  /** The code in the device's own format, when it reports one. */
  native: IrNativeCodeSchema.nullable(),
  timings: IrTimingsSchema,
  carrierHz: z.number().int().positive().nullable(),
})
export type IrLearnResult = z.infer<typeof IrLearnResultSchema>

/** One finished learn: when, whether it landed, and the typed refusal code. */
export const IrTransmitterAttemptSchema = z.object({
  at: z.number(),
  ok: z.boolean(),
  error: z.string().nullable(),
})
export type IrTransmitterAttempt = z.infer<typeof IrTransmitterAttemptSchema>

/** One finished send. `medium` is the transmitter's declared medium for that call. */
export const IrTransmitterSendRecordSchema = IrTransmitterAttemptSchema.extend({
  medium: IrMediumSchema,
})
export type IrTransmitterSendRecord = z.infer<typeof IrTransmitterSendRecordSchema>

/**
 * Last send and last learn. Null means the slice was read and that action has
 * not happened; an absent slice means the read has not answered.
 */
export const IrTransmitterRuntimeStateSchema = z.object({
  lastSend: IrTransmitterSendRecordSchema.nullable(),
  lastLearn: IrTransmitterAttemptSchema.nullable(),
  /** Ms epoch when the slice was last updated. */
  lastFetchedAt: z.number(),
})
export type IrTransmitterRuntimeState = z.infer<typeof IrTransmitterRuntimeStateSchema>

/** A send or a learn to fold into the slice. */
export type IrTransmitterStateUpdate =
  | {
      readonly kind: 'send'
      readonly ok: boolean
      readonly error: string | null
      readonly medium: IrMedium
    }
  | {
      readonly kind: 'learn'
      readonly ok: boolean
      readonly error: string | null
    }

/**
 * A learn the transmitter cannot do is not an attempt. Recording it would show
 * a failed learn for a device that never started one.
 */
export function irTransmitterRecordsUpdate(update: IrTransmitterStateUpdate): boolean {
  return !(update.kind === 'learn' && update.error === 'ir-transmitter.learn-unsupported')
}

/** The next slice after one send or learn. The other record is left as it was. */
export function irTransmitterStateAfter(
  previous: IrTransmitterRuntimeState | null,
  update: IrTransmitterStateUpdate,
  now: number,
): IrTransmitterRuntimeState {
  const prior = previous ?? { lastSend: null, lastLearn: null, lastFetchedAt: now }
  if (!irTransmitterRecordsUpdate(update)) return prior
  if (update.kind === 'send') {
    return {
      lastSend: { at: now, ok: update.ok, error: update.error, medium: update.medium },
      lastLearn: prior.lastLearn,
      lastFetchedAt: now,
    }
  }
  return {
    lastSend: prior.lastSend,
    lastLearn: { at: now, ok: update.ok, error: update.error },
    lastFetchedAt: now,
  }
}

/** The typed refusal code on an error, or null when the failure has none. */
export function irTransmitterErrorCode(err: unknown): string | null {
  return readErrorI18n(err)?.code ?? null
}

/**
 * ir-transmitter — emit a pulse train (infrared or RF) with settings. One cap
 * for both media: everything medium-specific is a per-call setting, validated
 * against what the transmitter declares in `getInfo`.
 *
 * `send` refuses with a typed user error: `ir-transmitter.offline` (the
 * transmitter cannot be reached) and `ir-transmitter.too-long` (more pulses
 * than the transmitter's `maxTimings`). A setting the transmitter cannot apply
 * is NOT a refusal: the train is sent and the key comes back in
 * `ignoredSettings`. `send` takes exactly one of `timings` or `native` (a code
 * in a format listed in `getInfo.formats`).
 *
 * `learn` waits for the user to point a remote at the transmitter and refuses
 * with `ir-transmitter.learn-unsupported`, `ir-transmitter.learn-timeout` or
 * `ir-transmitter.learn-undecodable`.
 */
export const irTransmitterCapability = {
  name: 'ir-transmitter',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Generic],
  methods: {
    send: method(
      z
        .object({
          deviceId: z.number().int().nonnegative(),
          timings: IrTimingsSchema.optional(),
          native: IrNativeCodeSchema.optional(),
          settings: TransmitSettingsSchema.optional(),
        })
        .refine((input) => (input.timings === undefined) !== (input.native === undefined), {
          message: 'send takes exactly one of timings or native',
        }),
      IrSendResultSchema,
      {
        kind: 'mutation',
        auth: 'protected',
        notOperatorFacing:
          'a raw pulse train is not something an operator composes in an automation; the remote that owns the command table sends it',
      },
    ),
    learn: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(IR_LEARN_TIMEOUT_MAX_MS)
          .default(IR_LEARN_TIMEOUT_DEFAULT_MS),
      }),
      IrLearnResultSchema,
      {
        kind: 'mutation',
        auth: 'protected',
        notOperatorFacing:
          'an interactive capture the operator starts from the source dialog and answers by pressing a physical remote; no automation can supply the signal',
      },
    ),
    getInfo: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      IrTransmitterInfoSchema,
      { kind: 'query', auth: 'protected' },
    ),
  },
  /**
   * Last send and last learn, for the device card. Written by the provider
   * on every attempt, including a typed refusal. A `learn-unsupported`
   * refusal is not an attempt and is not written.
   */
  runtimeState: IrTransmitterRuntimeStateSchema,
  /**
   * Runtime-state durability: **restored** — a last send and a last learn are
   * facts of what already happened. Restoring them is the card's content
   * after a restart; they are not a live reading that would lie.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): none — two event records, not a numeric series.
   */
  history: 'none',
  /** Clock field: written, but not on its own worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
  vocabulary: {
    noun: t('IR / RF transmitter', 'Trasmettitore IR / RF'),
    order: 1140,
  },
} as const satisfies CapabilityDefinition

export type IIrTransmitterProvider = InferProvider<typeof irTransmitterCapability>
