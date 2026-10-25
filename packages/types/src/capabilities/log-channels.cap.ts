/**
 * `log-channels` — the capability an addon DECLARES its diagnostic channels
 * through. It stores nothing.
 *
 * ## Why a capability at all, and why this shape
 *
 * Which channels exist is knowledge only the addon has: `stream-broker` knows
 * webrtc/ICE/RTP, `provider-reolink` knows baichuan/handshake. A central list
 * maintained by hand rots at the first addition and rots INVISIBLY — nothing
 * fails, an operator just never sees the channel somebody added. So the list
 * is assembled from declarations at runtime.
 *
 * The shape is copied from `log-destination.cap.ts`, which already does
 * exactly this job: `mode: 'collection'`, `internal: true`,
 * `mount: { kind: 'skip' }` — no tRPC route, no generated hooks — while
 * `addons.listCapabilityProviders` still enumerates it, and the hub's
 * `CapabilityRegistry` still holds an RPC proxy per provider so a forked
 * runner's declarations reach hub-main over the transport that already exists.
 * No new UDS message, no second registry.
 *
 * ## What it deliberately does NOT own
 *
 * The VALUES — which channel is armed, for which cameras, until when — live in
 * ONE place: the logging settings document on the `system` cap
 * (`getLoggingSettings` / `setLoggingSettings`). Two authorities over the same
 * value is the defect the plan behind this work exists to remove, and
 * `setRequestCensus` was retired (D245) rather than allowed to be a second
 * one. {@link logChannelsCapability} therefore has no getter for a level, no
 * setter for a window and no persistence of any kind.
 *
 * ## Why `apply` is here even so
 *
 * The gate lives in the addon's PROCESS; the document lives in hub-main. Some
 * seam has to carry the value from the authority to the mirror, and a channel
 * that cannot be reached is precisely the dead knob this whole slice exists to
 * make impossible (D62 — `audioThresholdDbfs`, the HA entities with no source).
 * `apply` is that seam and nothing more: it writes an in-memory mirror, it
 * persists nothing, it is never the source of a value, and it is called only
 * with a set the hub actually read (D49 — a read that fails does not call it
 * at all, so no channel is silently disarmed by a bad read).
 */

import { z } from 'zod'
import { LogChannelDescriptorSchema, LogChannelWindowSchema } from '../logging/log-channel.js'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/** What `apply` reports back — enough to log, not enough to be a second state. */
const LogChannelApplyResultSchema = z.object({
  /** How many declared channels are armed in this process after the call. */
  armed: z.number().int().min(0),
  /**
   * Names the document armed that this process does not declare. Reported
   * rather than swallowed: a name here is either a typo or an addon that has
   * not booted, and both deserve a line instead of silence.
   */
  unknown: z.array(z.string()).readonly(),
})

export const logChannelsCapability = {
  name: 'log-channels',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /** The channels this addon declares. Inert: no value, no state. */
    list: method(z.void(), z.array(LogChannelDescriptorSchema).readonly()),
    /**
     * Refresh this process's mirror from the document's FULL set of armed
     * windows.
     *
     * Full and not incremental on purpose: the document is the authority, so a
     * channel it does not name is disarmed here. An incremental apply would
     * let a disarm get lost in transit and leave a channel running that
     * nobody can see is running.
     */
    apply: method(
      z.object({ windows: z.array(LogChannelWindowSchema).readonly() }),
      LogChannelApplyResultSchema,
      { kind: 'mutation' },
    ),
  },
  /** In-process only — enumerated through `addons.listCapabilityProviders`. */
  mount: { kind: 'skip' },
} as const satisfies CapabilityDefinition

export type ILogChannelsProvider = InferProvider<typeof logChannelsCapability>

export type LogChannelApplyResult = z.infer<typeof LogChannelApplyResultSchema>

export { LogChannelApplyResultSchema }
