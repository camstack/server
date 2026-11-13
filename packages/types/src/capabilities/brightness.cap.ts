import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Dimmable-light brightness control. Co-exists with `switch` on the
 * same device — the switch toggles on/off, this cap sets the level
 * applied when the light is on. Drivers map their per-vendor dim
 * controls to this single-method surface.
 *
 * The cap is intentionally minimal: a single `setBrightness({deviceId,
 * level})` mutation plus the auto-injected `getStatus`. Drivers
 * that expose richer controls (color temperature, scenes, schedules)
 * should surface those via the device's `getSettingsUISchema()`
 * instead of bloating this cap.
 */
export const BrightnessStatusSchema = z.object({
  /** Current level as 0..100 inclusive. Firmware-reported. */
  level: z.number().min(0).max(100).meta(readingMeta('percentage')),
  /** Ms epoch of the last operator-driven change. Useful for UI freshness. */
  lastChangedAt: z.number(),
})

export type BrightnessStatus = z.infer<typeof BrightnessStatusSchema>

export const brightnessCapability = {
  name: 'brightness',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Light],
  methods: {
    setBrightness: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        level: z.number().min(0).max(100),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'brightness.full',
            label: t('Full brightness', 'Luminosità massima'),
            phrase: t('Set {device} to full brightness', 'Porta {device} alla massima luminosità'),
            icon: 'sun',
            effect: { field: 'level', value: 100 },
            args: { level: 100 },
          },
          {
            id: 'brightness.half',
            label: t('Half brightness', 'Luminosità a metà'),
            phrase: t('Dim {device} to half', 'Abbassa {device} a metà luminosità'),
            icon: 'sun-dim',
            effect: { field: 'level', value: 50 },
            args: { level: 50 },
          },
          {
            id: 'brightness.off',
            label: t('Brightness off', 'Luminosità a zero'),
            phrase: t('Dim {device} to zero', 'Abbassa {device} a zero'),
            icon: 'lightbulb-off',
            effect: { field: 'level', value: 0 },
            args: { level: 0 },
          },
          {
            id: 'brightness.set',
            label: t('Set brightness', 'Imposta la luminosità'),
            phrase: t(
              'Set the brightness of {device} to {level}',
              'Imposta la luminosità di {device} a {level}',
            ),
            icon: 'sun-medium',
            effect: { field: 'level', fromArg: 'level' },
            openArgs: [
              {
                key: 'level',
                label: t('Percentage', 'Percentuale'),
                offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
              },
            ],
          },
        ],
      },
    ),
  },
  events: {
    /**
     * Emitted whenever the brightness changes — operator action OR
     * firmware push. Subscribers (UI sliders, automation engines) react
     * without polling.
     */
    onBrightnessChanged: {
      data: z.object({
        deviceId: z.number(),
        level: z.number().min(0).max(100),
        lastChangedAt: z.number(),
      }),
      notOperatorFacing: 'the `level` state trigger reads the same change',
    },
  },
  status: {
    schema: BrightnessStatusSchema,
    kind: 'command-driven',
  },
  /**
   * Runtime-state slice — the last applied brightness level, mirrored
   * by the kernel. Read via `device.state.brightness.value` so UI
   * sliders surface the current level without polling the provider.
   */
  runtimeState: BrightnessStatusSchema,

  /**
   * Runtime-state durability: **session** — live lamp state, re-published by the provider on connect.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series. Actuator tier: level keeps every change.
   */
  history: {
    fields: {
      level: { kind: 'gauge', unit: '%', minIntervalMs: 0 },
    },
  },
  vocabulary: {
    noun: t('Brightness', 'Luminosità'),
    order: 1010,
    state: [
      {
        kind: 'numeric',
        field: 'level',
        quantity: t('the brightness', 'la luminosità'),
        label: t('Brightness', 'Luminosità'),
        unit: '%',
        icon: 'sun',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IBrightnessProvider = InferProvider<typeof brightnessCapability>
