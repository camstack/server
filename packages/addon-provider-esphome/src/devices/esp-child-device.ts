import { z } from 'zod'
import { BaseDevice, type DeviceContext, type DeviceFeature } from '@camstack/types'
import { espLinkHub } from '../esphome-link-hub.js'
import type { EspCommand, EspLink, EspState } from '../esphome-link.js'

/** Entity kinds a child can be built for (see `esphome-entity-spec.ts`). */
export const ESP_CHILD_KINDS = [
  'switch',
  'light',
  'cover',
  'button',
  'number-control',
  'select-control',
  'event',
  'numeric-sensor',
  'enum-sensor',
  'contact',
  'flood',
  'smoke',
  'motion',
  'binary',
  'power-meter',
] as const

/**
 * Persisted config of every ESPHome accessory child. The container stamps it at
 * spawn from the plan (`planBoard`), so a child restores without the board being
 * reachable: everything needed to register its caps is here, not in the link.
 */
export const espChildSchema = z.object({
  brokerId: z.string().min(1).describe('Board this child belongs to'),
  kind: z.enum(ESP_CHILD_KINDS),
  /** The board entity behind a one-to-one child. */
  entityId: z.string().optional(),
  /** Power meter only: field -> entity id. */
  slots: z.record(z.string(), z.string()).optional(),
  /** Per-field source unit of a power meter, keyed like `slots`. */
  slotUnits: z.record(z.string(), z.string()).optional(),
  unit: z.string().optional(),
  deviceClass: z.string().optional(),
  options: z.array(z.string()).optional(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  step: z.number().nullable().optional(),
  eventTypes: z.array(z.string()).optional(),
  supportsBrightness: z.boolean().optional(),
  supportsPosition: z.boolean().optional(),
  supportsStop: z.boolean().optional(),
})

export type EspChildConfig = z.infer<typeof espChildSchema>

/** `seed` = a replay of the last known state, whose change time is unknown. */
export type EspStateOrigin = 'live' | 'seed'

/**
 * Shared base of the ESPHome accessory children: resolves the board's link
 * through the hub, replays the last known state when the link (re)appears and
 * routes live state to the one entity (or the few, for a power meter) it owns.
 *
 * Going offline changes nothing here on purpose: a child keeps its last reading
 * and the container flips `online`, so an unreachable board never reads as 0.
 */
export abstract class EspChildDevice extends BaseDevice<typeof espChildSchema> {
  readonly features: readonly DeviceFeature[] = []

  protected readonly brokerId: string
  protected readonly child: EspChildConfig
  private unsubscribeHub: (() => void) | null = null

  protected constructor(ctx: DeviceContext) {
    const parsed = espChildSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, espChildSchema, { type: ctx.deviceMeta.type })
    this.brokerId = parsed.brokerId
    this.child = parsed
  }

  /** Entity ids whose state this child decodes. */
  protected abstract ownedEntityIds(): readonly string[]

  /** Decode one state of an owned entity into the cap slice. */
  protected abstract applyState(state: EspState, origin: EspStateOrigin): void

  /** Subscribe to the board. Call once, at the end of the subclass constructor. */
  protected attach(): void {
    this.unsubscribeHub = espLinkHub.subscribe(this.brokerId, (event) => {
      if (event.kind === 'state') this.route(event.state, 'live')
      else if (event.kind === 'connected') this.replay(event.link)
    })
    const link = espLinkHub.link(this.brokerId)
    if (link !== null) this.replay(link)
  }

  /** Send a command to the board; a board that is not reachable refuses by name. */
  protected send(command: EspCommand): void {
    const link = espLinkHub.link(this.brokerId)
    if (link === null) {
      throw new Error(`ESPHome board is not connected (broker ${this.brokerId})`)
    }
    link.command(command)
  }

  protected unsupported(surface: string): never {
    throw new Error(`ESPHome: ${surface} is not supported by this entity`)
  }

  override async removeDevice(): Promise<void> {
    this.unsubscribeHub?.()
    this.unsubscribeHub = null
  }

  private replay(link: EspLink): void {
    for (const state of link.snapshot()) this.route(state, 'seed')
  }

  private route(state: EspState, origin: EspStateOrigin): void {
    if (!this.ownedEntityIds().includes(state.id)) return
    this.applyState(state, origin)
  }
}

/** A change stamp: now when the value changed, otherwise the previous stamp. */
export function stampOnChange(previous: number, changed: boolean, now: number): number {
  return changed ? now : previous
}
