/**
 * THE bridge accessory — one per node, created on demand, holding every
 * non-camera accessory the operator routed onto it.
 *
 * One mDNS advertisement, one HAP connection, one pairing, N accessories
 * inside. The alternative — what this addon did until now — gives every
 * switch, sensor and alarm panel its own port, its own advertisement and its
 * own "Add Accessory" in the Home app. Cameras stay standalone, because
 * HomeKit forbids bridging them (`bridge-policy.ts`).
 *
 * ONE bridge, deliberately. The ceiling is 149 accessories
 * ({@link MAX_BRIDGED_ACCESSORIES}) and this hub exposes 46 devices in total,
 * cameras included; a second bridge is a thing to build when the count
 * approaches the ceiling, not before, and the refusal at the ceiling is
 * explicit rather than a library throw.
 *
 * The bridge is LAZY: it is published the first time an accessory needs it,
 * so a fleet of nothing but cameras advertises no empty bridge. It is not
 * unpublished when the last accessory leaves — an unpublish would drop the
 * pairing record the operator already entered a code for, and an empty bridge
 * in the Home app is a far smaller cost than a re-pair.
 */
import { Accessory, Categories } from '@homebridge/hap-nodejs'
import type { IScopedLogger } from '@camstack/types'

import { bridgeHasRoom, MAX_BRIDGED_ACCESSORIES } from './bridge-policy.js'
import { publishStandalone, unpublishAccessory } from './accessory-publisher.js'

export interface BridgeHostOptions {
  readonly displayName: string
  readonly uuid: string
  readonly pincode: string
  readonly bind?: string | undefined
  readonly logger: IScopedLogger
  /**
   * How the bridge reaches the network. Injected so a test can exercise the
   * lazy publish and the full-bridge fallback without a HAP server or an mDNS
   * advertisement; production passes nothing and gets `publishStandalone`.
   */
  readonly publish?: (accessory: Accessory, pincode: string) => Promise<void>
}

export class BridgeHost {
  private bridge: Accessory | null = null
  private published = false

  constructor(private readonly opts: BridgeHostOptions) {}

  /** The live bridge accessory, or `null` before anything needed one. */
  get accessory(): Accessory | null {
    return this.bridge
  }

  /** How many accessories are riding it right now. */
  get size(): number {
    return this.bridge?.bridgedAccessories.length ?? 0
  }

  /**
   * Put an accessory on the bridge, publishing the bridge if this is the
   * first. Returns `false` — without throwing, and having logged — when the
   * bridge is full: the caller then falls back to standalone, which is worse
   * for the operator and still works.
   */
  async add(accessory: Accessory): Promise<boolean> {
    const bridge = this.ensure()
    if (!bridgeHasRoom(bridge.bridgedAccessories.length)) {
      this.opts.logger.warn('export-hap: the bridge is FULL — publishing standalone instead', {
        meta: {
          uuid: accessory.UUID,
          bridged: bridge.bridgedAccessories.length,
          max: MAX_BRIDGED_ACCESSORIES,
        },
      })
      return false
    }
    bridge.addBridgedAccessory(accessory)
    await this.publishOnce()
    return true
  }

  /** Take an accessory off the bridge. A bridged accessory is never
   *  `unpublish`ed — it has no server of its own. */
  remove(accessory: Accessory): void {
    if (this.bridge === null) return
    if (!this.bridge.bridgedAccessories.some((a) => a.UUID === accessory.UUID)) return
    this.bridge.removeBridgedAccessory(accessory, false)
  }

  /** Whether this accessory is currently on the bridge. */
  holds(accessory: Accessory): boolean {
    return this.bridge?.bridgedAccessories.some((a) => a.UUID === accessory.UUID) ?? false
  }

  /** Tear the bridge down — process shutdown only. */
  async dispose(): Promise<void> {
    if (this.bridge === null || !this.published) return
    await unpublishAccessory(this.bridge, this.opts.logger)
    this.published = false
  }

  private ensure(): Accessory {
    if (this.bridge !== null) return this.bridge
    const bridge = new Accessory(this.opts.displayName, this.opts.uuid)
    bridge.category = Categories.BRIDGE
    this.bridge = bridge
    return bridge
  }

  private async publishOnce(): Promise<void> {
    if (this.published || this.bridge === null) return
    if (this.opts.publish !== undefined) {
      await this.opts.publish(this.bridge, this.opts.pincode)
    } else {
      await publishStandalone(this.bridge, {
        pincode: this.opts.pincode,
        port: 0,
        bind: this.opts.bind,
        logger: this.opts.logger,
      })
    }
    this.published = true
    this.opts.logger.info('export-hap: the bridge is published', {
      meta: { displayName: this.opts.displayName, uuid: this.opts.uuid },
    })
  }
}
