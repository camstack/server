import { z } from 'zod'

/**
 * HA WebSocket entity state envelope. Mirrors the `subscribe_entities`
 * compact payload (post-`processEvent` reduction) — what consumers
 * downstream actually see when they read a freshly-updated entity.
 *
 * Schema is permissive on `state` / `attributes` because the HA
 * surface is polymorphic across domains; per-domain narrowing happens
 * in the materialisation factory (Phase E) where each domain becomes
 * its own DeviceType + cap set.
 */
export const HaEntityStateSchema = z.object({
  entity_id: z.string().min(1),
  /** Domain-specific state value (`on`/`off`/`open`/temperature
   *  number-as-string/etc.). Always a string in HA. */
  state: z.string(),
  /** Free-form attribute map. Domain-specific. */
  attributes: z.record(z.string(), z.unknown()),
  /** Optional context envelope (user/parent id) the HA server attaches. */
  context: z
    .object({
      id: z.string(),
      parent_id: z.string().nullable(),
      user_id: z.string().nullable(),
    })
    .optional(),
  /** ISO 8601 timestamp of the last state change. */
  last_changed: z.string(),
  /** ISO 8601 timestamp of the last update (state OR attributes). */
  last_updated: z.string(),
})

export type HaEntityState = z.infer<typeof HaEntityStateSchema>

/**
 * Compact-format update envelope emitted by HA's `subscribe_entities`.
 * Three operations partition the diff:
 *  - `a` (add) — new entity entered the subscription set
 *  - `r` (remove) — entity left the subscription set
 *  - `c` (change) — delta on an existing entity's state / attributes /
 *    context / timestamps
 *
 * Field names are single-letter because they cross the WebSocket on
 * every push — HA optimised the protocol for bandwidth, not legibility.
 */
export interface HaCompactStateNew {
  /** state */
  s: string
  /** attributes */
  a?: Record<string, unknown>
  /** context — either an id string or full envelope */
  c?: string | { id: string; parent_id: string | null; user_id: string | null }
  /** last_changed (epoch seconds) */
  lc: number
  /** last_updated (epoch seconds) — omitted when same as lc */
  lu?: number
}

export interface HaCompactStateDelta {
  /** add — fields/keys to set */
  '+'?: {
    s?: string
    a?: Record<string, unknown>
    c?: string | { id: string; parent_id: string | null; user_id: string | null }
    lc?: number
    lu?: number
  }
  /** remove — attribute keys to delete */
  '-'?: {
    a?: string[]
  }
}

export interface HaCompactUpdate {
  /** added entities */
  a?: Record<string, HaCompactStateNew>
  /** removed entity ids */
  r?: string[]
  /** changed entities */
  c?: Record<string, HaCompactStateDelta>
}

/**
 * Auth strategy. Two mutually-exclusive options:
 *  - `supervisor` — invoked when the addon runs as a HA Supervisor
 *    addon and the runtime injects `SUPERVISOR_TOKEN`. The WS URL is
 *    fixed at `ws://supervisor/core/websocket`.
 *  - `long-lived` — the user pastes a long-lived access token in
 *    the addon config; the WS URL points at their HA instance
 *    (`ws://ha.example:8123/api/websocket` style).
 */
export const HaAuthConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('supervisor'),
    /** Token injected by the Supervisor at runtime via env. */
    supervisorToken: z.string().min(1).meta({ secret: true }),
  }),
  z.object({
    kind: z.literal('long-lived'),
    /** Origin URL of the HA instance (e.g. `https://ha.example:8123`). */
    baseUrl: z.url(),
    /** Long-lived access token issued by the user in their HA profile. */
    accessToken: z.string().min(1).meta({ secret: true }),
  }),
])

export type HaAuthConfig = z.infer<typeof HaAuthConfigSchema>

/** HA's standard domain enum — supported subset; future domains added
 *  as integration coverage grows. */
export enum HaDomain {
  // Sensors
  Sensor = 'sensor',
  BinarySensor = 'binary_sensor',
  // Switching / state
  Switch = 'switch',
  Light = 'light',
  Lock = 'lock',
  Cover = 'cover',
  Fan = 'fan',
  Climate = 'climate',
  MediaPlayer = 'media_player',
  AlarmControlPanel = 'alarm_control_panel',
  // Presence / location
  Person = 'person',
  DeviceTracker = 'device_tracker',
  // User-settable inputs
  Number = 'number',
  InputNumber = 'input_number',
  Select = 'select',
  InputSelect = 'input_select',
  Text = 'text',
  InputText = 'input_text',
  InputDateTime = 'input_datetime',
  InputBoolean = 'input_boolean',
  // Imperative
  Script = 'script',
  Automation = 'automation',
  Notify = 'notify',
}
