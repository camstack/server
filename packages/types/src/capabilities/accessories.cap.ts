import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * List of accessory children linked to a parent device. The cap surfaces
 * the grouping and the per-child UI-visibility flag — the single source
 * of truth for what an accessory IS remains the child device itself
 * (resolved via `device-manager.getDevice` from the listed numeric ids).
 *
 * Two parallel arrays:
 *   - `childDeviceIds` — every accessory child the parent recognises
 *   - `hiddenChildIds` — subset that the operator chose to hide from
 *     the parent's UI surface (panels / detail page / grid). The hidden
 *     children remain registered and continue to receive state updates;
 *     they're omitted only from the parent's UI accessories view.
 *
 * Use cases:
 *   - Camera parents hiding seldom-used accessories (e.g. a chime that
 *     was provisioned but isn't connected to anything).
 *   - HA-integration parents hiding entity-children the user doesn't
 *     care about (an "Aqara plug" exposes one switch + 3 sensors —
 *     the operator may want only the switch visible).
 *
 * Toggling visibility is the parent provider's responsibility — it
 * implements `setChildHidden` and persists the set so reboots survive.
 */
export const AccessoriesStatusSchema = z.object({
  /** All accessory children of the parent. */
  childDeviceIds: z.array(z.number()).readonly(),
  /** Subset of `childDeviceIds` the operator hid from the UI. The order
   *  is irrelevant; the array is treated as a set by consumers. */
  hiddenChildIds: z.array(z.number()).readonly(),
})

export type AccessoriesStatus = z.infer<typeof AccessoriesStatusSchema>

export const accessoriesCapability = {
  name: 'accessories',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  // Cameras + Hubs are the historical consumers; the HA integration
  // landed in Phase E adds Switch / Light / Sensor / Thermostat / Cover
  // / Lock / Fan / MediaPlayer / AlarmPanel / Generic as parent types
  // for adopted HA devices whose entity-children sit under accessories.
  deviceTypes: [
    DeviceType.Camera,
    DeviceType.Hub,
    DeviceType.Switch,
    DeviceType.Light,
    DeviceType.Sensor,
    DeviceType.Thermostat,
    DeviceType.Cover,
    DeviceType.Lock,
    DeviceType.Fan,
    DeviceType.MediaPlayer,
    DeviceType.AlarmPanel,
    DeviceType.Generic,
  ],
  methods: {
    /**
     * Toggle the UI-visibility of a single accessory child. Hidden
     * children stay registered and continue to receive state updates;
     * they're omitted only from the parent's UI accessories panel.
     *
     * Idempotent — hiding an already-hidden child or unhiding a
     * non-hidden child is a no-op. Providers that don't support
     * per-child visibility may implement this as a no-op (the UI hide
     * toggle gracefully degrades).
     */
    setChildHidden: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        childDeviceId: z.number().int().nonnegative(),
        hidden: z.boolean(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  events: {
    /**
     * Emitted when a child device is created, removed, or its parent
     * assignment changes. Payload carries the fresh list and the
     * hidden subset.
     */
    onAccessoriesChanged: {
      data: z.object({
        deviceId: z.number(),
        childDeviceIds: z.array(z.number()).readonly(),
        hiddenChildIds: z.array(z.number()).readonly(),
      }),
    },
    /**
     * Emitted when the operator toggles a child's UI-visibility.
     * Subscribers (admin UI accessories panel) re-render off this
     * signal without re-fetching the full status block.
     */
    onChildVisibilityChanged: {
      data: z.object({
        deviceId: z.number(),
        childDeviceId: z.number(),
        hidden: z.boolean(),
      }),
    },
  },
  status: {
    schema: AccessoriesStatusSchema,
    kind: 'command-driven',
  },
} as const satisfies CapabilityDefinition

export type IAccessoriesProvider = InferProvider<typeof accessoriesCapability>
