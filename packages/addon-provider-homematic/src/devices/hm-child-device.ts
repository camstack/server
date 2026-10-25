import { BaseDevice, type DeviceContext, type DeviceFeature } from '@camstack/types'
import type { HmDevice, Homematic, ValueChangedEvent } from 'nodehomematic'
import { z } from 'zod'
import { homematicFacades } from '../homematic-gateway.js'
import type { HmValueOrigin } from './hm-change-stamp.js'

/**
 * Persisted config every Homematic accessory CHILD carries. `address` is the
 * CCU device address (the dispatch key the child uses to resolve its live
 * `HmDevice` from the facade and to filter inbound `valueChanged` events to
 * its own device). `channel` is the channel the child owns (cap routing).
 *
 * Subclasses extend this with their own fields (`kind`, `capabilities`,
 * `role`, `unit`, `sourceParams`, …) via `hmChildSchema.extend({...})`.
 */
export const hmChildSchema = z.object({
  address: z.string().min(1).describe('CCU device address'),
  brokerId: z.string().optional().describe('Registry broker id (primary when absent)'),
  /** Channel address this child owns (e.g. `0001D3C99AB001:4`). Optional for
   *  children that span multiple channels (event-emitter) or none (update). */
  channel: z.string().optional(),
})

export type HmChildConfig = z.infer<typeof hmChildSchema>

/**
 * A child's value handler. `origin` says whether the value is a live CCU
 * event or a replay of the cached value (`seedCurrentValues`) — the one fact a
 * decoder needs to know whether it may stamp a CHANGE time (`hm-change-stamp.ts`).
 */
export type HmValueHandler = (event: ValueChangedEvent, origin: HmValueOrigin) => void

/**
 * Shared base for every Homematic accessory child (actuator / sensor / event /
 * diagnostic / update). Holds the address + brokerId + channel resolved from
 * config and the facade-resolution seam lifted VERBATIM from the (legacy) flat
 * `HomematicDevice`. Concrete subclasses register their cap(s) and (where
 * relevant) attach a `valueChanged` listener filtered by device address.
 *
 * Children are spawned by `HmContainerDevice.getAccessoryChildren()` via the
 * kernel accessory-spawn path; their cap registration + broker wiring happen in
 * `onActivate` (mirrors `HaBaseChildDevice`) so `registerNativeCap` lands AFTER
 * the device is registered with the kernel.
 */
export abstract class HmChildDevice<
  S extends z.ZodObject<z.core.$ZodLooseShape>,
> extends BaseDevice<S> {
  readonly features: readonly DeviceFeature[] = []

  /** CCU device address — dispatch + event-filter key. */
  protected readonly address: string

  /** Registry broker id; undefined falls back to the primary broker. */
  protected readonly brokerId: string | undefined

  /** Channel address this child owns (undefined for multi/no-channel kinds). */
  protected readonly channel: string | undefined

  /** Unsubscribe for the facade `valueChanged` listener. */
  private valueChangedUnsub: (() => void) | null = null

  /** Unsubscribes for the seed-trigger listeners (`ready` / `connection`). */
  private seedTriggerUnsubs: ReadonlyArray<() => void> = []

  /** The subclass value handler — replayed over current cached values when the
   *  library finishes initial-value seeding (the `ready` event) or reconnects. */
  private valueHandler: HmValueHandler | null = null

  protected constructor(ctx: DeviceContext, schema: S) {
    const persisted = (ctx.persistedConfig ?? {}) as Partial<HmChildConfig>
    const address = persisted.address
    if (typeof address !== 'string' || address.length === 0) {
      throw new Error(`HmChildDevice: missing address in persisted config (id=${ctx.id})`)
    }
    super(ctx, schema, { type: ctx.deviceMeta.type })
    this.address = address
    this.brokerId = typeof persisted.brokerId === 'string' ? persisted.brokerId : undefined
    this.channel = typeof persisted.channel === 'string' ? persisted.channel : undefined
    void this.updateSourceInfo({ id: this.address, system: 'homematic' })
  }

  /** The live facade for this device's CCU, or null when disconnected. */
  protected get facade(): Homematic | null {
    return homematicFacades.get(this.brokerId ?? null)
  }

  /** Resolve this child's current `HmDevice` snapshot from the facade. */
  protected resolveHmDevice(): HmDevice | null {
    const facade = this.facade
    if (!facade) return null
    return facade.devices().find((d) => d.address === this.address) ?? null
  }

  /** Narrow the optional facade to a present one or throw a clear error. */
  protected requireFacade(): Homematic {
    const facade = this.facade
    if (!facade) {
      throw new Error(`HmChildDevice: CCU connection unavailable (address=${this.address})`)
    }
    return facade
  }

  /** Reject an operation the underlying HmIP hardware does not support. */
  protected unsupported(surface: string): never {
    throw new Error(`HmChildDevice: ${surface} not supported (address=${this.address})`)
  }

  /**
   * Attach a facade `valueChanged` listener filtered to this child's device
   * address AND — when the child owns one — to its channel. The
   * subclass-supplied `handle` runs only for matching events. No-ops when no
   * facade is present (the child reconnects on next reconcile).
   */
  protected attachValueChangedListener(handle: HmValueHandler): void {
    this.valueHandler = handle
    const facade = this.facade
    if (!facade) return
    this.valueChangedUnsub = facade.on('valueChanged', (event) => {
      if (event.device !== this.address) return
      if (!this.ownsEventChannel(event)) return
      handle(event, 'live')
    })
    // The library seeds current values at startup SILENTLY (no `valueChanged`),
    // then publishes `ready`; it re-seeds on reconnect (`connection`). A child
    // that only listens to `valueChanged` would otherwise show nothing until a
    // value actually CHANGES (e.g. until the operator actuates the cover). So we
    // replay the current cached values through the same handler on `ready` /
    // `connection`, plus once immediately in case seeding already completed.
    this.seedTriggerUnsubs = [
      facade.on('ready', () => this.seedCurrentValues()),
      facade.on('connection', () => this.seedCurrentValues()),
    ]
    this.seedCurrentValues()
  }

  /**
   * Whether an inbound value event belongs to THIS child's channel.
   *
   * One CCU device address can host SEVERAL independent functional entities —
   * an HmIP-BS2 carries two unrelated relays, on `<addr>:4` and `<addr>:8`, and
   * BOTH emit `STATE`. Filtering on the device address alone let either relay's
   * event write the other's slice: actuating one made both report ON while only
   * one was physically on. The seed path (`seedCurrentValues`) has always been
   * channel-scoped; this makes the live path agree with it.
   *
   * Channel-less children (event-emitter, firmware update) span the whole
   * device by design and accept every channel.
   */
  /**
   * Every channel this child may accept, ASKED OF THE LIBRARY.
   *
   * An HmIP cover reports its position on the SHUTTER_TRANSMITTER channel and
   * is commanded on a SHUTTER_VIRTUAL_RECEIVER, so the command channel alone
   * drops exactly the reports the entity exists to expose — measured: the
   * receiver held 100 % while the slat sat at 47.5 %, and the library's own fix
   * was invisible here because these events never got past the filter.
   *
   * `HmCustomEntity.channels` is the library's answer, so the `-1` offset lives
   * in ONE place (the profile) rather than being re-spelled here. Falls back to
   * the command channel alone when the entity cannot be resolved — a narrower
   * filter is the safe direction: it costs a report, where a wider one lets a
   * sibling relay write this child's slice.
   */
  private ownedChannels(): readonly string[] {
    const owned = this.channel
    if (owned === undefined) return []
    const declared = this.entityChannels()
    return declared.all.length > 0 ? declared.all : [owned]
  }

  /**
   * The entity's channels, split into all-of-them and the STATUS ones.
   *
   * Both are needed and they answer different questions. `all` is what may be
   * accepted at all; `status` is where a parameter must be taken FROM when it
   * exists in both places — `LEVEL` is on an HmIP cover's transmitter AND its
   * virtual receiver, so merely accepting both and letting the last arrival
   * win is a coin toss the receiver keeps winning: 100 % against a slat at
   * 47.5 %. Measured, after widening the filter and before this.
   */
  private entityChannels(): { all: readonly string[]; status: readonly string[] } {
    const owned = this.channel
    const entities = this.facade?.customEntities() ?? []
    const mine = entities.find((e) => e.device === this.address && e.channel === owned)
    if (mine === undefined) return { all: [], status: [] }
    const all = 'channels' in mine ? mine.channels : []
    const status = 'statusChannels' in mine ? mine.statusChannels : []
    return { all, status }
  }

  /**
   * Is this (channel, parameter) the one to believe?
   *
   * A parameter carried by a STATUS channel is taken only from there. Anything
   * else passes — a command-only datapoint (`STOP`) has no status twin, and a
   * device with no split has no status channels at all.
   */
  private isPreferredSource(event: ValueChangedEvent): boolean {
    const { status } = this.entityChannels()
    if (status.length === 0) return true
    if (status.includes(event.channel)) return true
    const device = this.resolveHmDevice()
    const onStatus = device?.channels.some(
      (c) =>
        status.includes(c.address) &&
        (c.dataPoints ?? []).some((d) => d.parameter === event.parameter),
    )
    return onStatus !== true
  }

  private ownsEventChannel(event: ValueChangedEvent): boolean {
    const owned = this.channel
    if (owned === undefined) return true
    const channel = event.channel
    if (typeof channel === 'string' && channel.length > 0) {
      if (!this.ownedChannels().includes(channel)) return false
      return this.isPreferredSource(event)
    }
    // Unmappable: we cannot tell which entity of a multi-entity device this
    // belongs to, and defaulting to "all channels" is exactly the collapse
    // above. Drop it — loudly, never silently.
    this.ctx.logger.warn('Homematic value event without a channel — dropped', {
      tags: { deviceId: this.ctx.id },
      meta: { address: this.address, ownedChannel: owned, parameter: event.parameter },
    })
    return false
  }

  /**
   * Replay this child's CURRENT cached datapoint values through the registered
   * value handler. Reads the live `HmDevice` snapshot (the library backfills the
   * seeded values onto its datapoints) and feeds each non-null value on THIS
   * child's channel as a synthetic change — reusing the subclass decoders so the
   * slice reflects reality without waiting for a live change.
   *
   * A replay is a KNOWN value with an UNKNOWN change time, so it reaches the
   * handler as `origin: 'seed'` and the decoders never stamp it as a change
   * that happened now (`hm-change-stamp.ts`). `ts` stays the read time: it is
   * the truth for a measurement's `lastFetchedAt`.
   *
   * Channel-less children (event-emitter, update) are skipped: an event-emitter
   * would otherwise fire a spurious button press from a non-null `PRESS_*`
   * datapoint, and the update child reads firmware live in `getStatus`.
   */
  protected seedCurrentValues(): void {
    const handle = this.valueHandler
    if (handle === null || this.channel === undefined) return
    const device = this.resolveHmDevice()
    if (device === null) return
    const now = Date.now()
    // The SAME channel set the live path accepts. Seeding only the command
    // channel is why a restart left the cover reading its last commanded
    // extreme — 100 % against a CCU that said 47.5 % — until somebody moved it.
    const accepted = this.ownedChannels()
    for (const channel of device.channels) {
      if (!accepted.includes(channel.address)) continue
      for (const dp of channel.dataPoints ?? []) {
        if (dp.value === null || dp.value === undefined) continue
        // Same preference as the live path, or the seed would replay the
        // receiver's LEVEL over the transmitter's and undo itself.
        if (
          !this.isPreferredSource({
            dpId: dp.id,
            device: this.address,
            channel: channel.address,
            parameter: dp.parameter,
            value: dp.value,
            prevValue: null,
            ts: now,
          })
        )
          continue
        handle(
          {
            dpId: dp.id,
            device: this.address,
            channel: channel.address,
            parameter: dp.parameter,
            value: dp.value,
            prevValue: null,
            ts: now,
          },
          'seed',
        )
      }
    }
  }

  override async removeDevice(): Promise<void> {
    for (const unsub of [this.valueChangedUnsub, ...this.seedTriggerUnsubs]) {
      if (!unsub) continue
      try {
        unsub()
      } catch {
        // best-effort — device is being torn down regardless
      }
    }
    this.valueChangedUnsub = null
    this.seedTriggerUnsubs = []
  }
}
