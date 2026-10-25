/**
 * Who may an Alexa link reach? (S1, D767)
 *
 * The account-linking token is minted at consent with `category:device
 * [view, create]` whatever the consenting user may do, and until this module
 * nothing downstream asked WHO consented: a viewer-only hub user who linked
 * Alexa received every exposed camera, its PTZ, its siren and the alarm panel,
 * and could actuate any device id he could spell into an endpoint id.
 *
 * The link already carries its identity — the token's `userId` claim is the
 * camstack user who consented, and `oauthVerifyAccessToken` returns it. What
 * was missing is enforcement. This gate intersects the link with that user's
 * LIVE grants, read from the authority that owns them (`userManagement`), and
 * resolved with the SAME selector engine the tRPC middleware uses
 * (`resolveViewableDeviceIds`, `@camstack/types`) so the two can never
 * disagree about a device:
 *
 *  - an admin user's link reaches every exposed device;
 *  - a scoped user's link reaches what that user's `device` / `category:device`
 *    grants cover at the access the directive needs (`view` to see and stream,
 *    `create` to actuate), including the parent → accessory inheritance rules;
 *  - an unknown (deleted) user reaches nothing.
 *
 * Reads are LIVE but cached for {@link USER_GRANTS_TTL_MS} so a ReportState
 * poll is not a user-store read; a revoked grant applies within that window. A
 * refresh that FAILS keeps the last good read (a failed read changes nothing,
 * D49); a gate that has never read successfully answers `unavailable`, and
 * every caller treats that as a refusal.
 */
import type { DeviceMetaLike, IScopedLogger, MethodAccess, UserScope } from '@camstack/types'
import { errMsg, resolveViewableDeviceIds } from '@camstack/types'
import type { ParsedEndpointId } from '../handlers/endpoint-id.js'

/** How long a user-grants read is trusted before the next directive re-reads. */
export const USER_GRANTS_TTL_MS = 30_000

/** How long a device's type / location / parent is trusted. */
export const DEVICE_META_TTL_MS = 60_000

/** Ancestor-walk bound — defence against a corrupt parentage cycle. */
const MAX_ANCESTOR_HOPS = 8

/** One hub user's grants, as the gate needs them. */
export interface AlexaUserGrant {
  readonly userId: string
  readonly isAdmin: boolean
  readonly scopes: readonly UserScope[]
}

/** The user a link acts for, classified. */
export type AlexaPrincipal =
  | { readonly kind: 'admin'; readonly userId: string }
  | { readonly kind: 'scoped'; readonly userId: string; readonly scopes: readonly UserScope[] }

export type PrincipalLookup =
  | { readonly kind: 'found'; readonly principal: AlexaPrincipal }
  /** The user record is gone: the link reaches nothing. */
  | { readonly kind: 'unknown-user' }
  /** The user store could not be read and nothing was cached. Refuse. */
  | { readonly kind: 'unavailable'; readonly error: string }

/**
 * `unknown` is not `denied`: the registry could not say what the device is.
 * A directive refuses it (fail closed); the visibility reconcile keeps the
 * previous answer instead of deleting the user's endpoint over one bad read.
 */
export type AccessVerdict = 'allowed' | 'denied' | 'unknown'

export function principalFromGrant(grant: AlexaUserGrant): AlexaPrincipal {
  return grant.isAdmin
    ? { kind: 'admin', userId: grant.userId }
    : { kind: 'scoped', userId: grant.userId, scopes: grant.scopes }
}

/**
 * Does `principal` reach `chain[0]` at `access`? `chain` is the device followed
 * by its ancestors (parent first), each with the metadata a selector needs.
 * Pure — the one derivation shared by directives, discovery and the event mirror.
 */
export function principalAllowsDevice(
  principal: AlexaPrincipal,
  chain: readonly DeviceMetaLike[],
  access: MethodAccess,
): boolean {
  if (principal.kind === 'admin') return true
  const target = chain[0]
  if (target === undefined) return false
  return resolveViewableDeviceIds(principal.scopes, chain, access).has(target.id)
}

/** What an endpoint id addresses, for the access check. */
export interface EndpointAccessTarget {
  /** The exposed (top-level) device the endpoint is published under. */
  readonly exposedDeviceId: number
  /** The device a directive on this endpoint reads or actuates. */
  readonly deviceId: number
  /** When set, `deviceId` must be a child of this device — a forged
   *  `<exposed>__<anything>` must not reach an unrelated device. */
  readonly requiresParent: number | null
  /** The access a user needs for the endpoint to be DISCOVERED at all: `view`
   *  for a camera / panel / sensor, `create` for an endpoint that is nothing
   *  but an actuator (privacy, autotrack, a siren or light). */
  readonly ownAccess: MethodAccess
}

export function endpointAccessTarget(parsed: ParsedEndpointId): EndpointAccessTarget | null {
  switch (parsed.kind) {
    case 'camera':
      return {
        exposedDeviceId: parsed.deviceId,
        deviceId: parsed.deviceId,
        requiresParent: null,
        ownAccess: 'view',
      }
    case 'privacy':
    case 'autotrack':
      return {
        exposedDeviceId: parsed.parentDeviceId,
        deviceId: parsed.parentDeviceId,
        requiresParent: null,
        ownAccess: 'create',
      }
    case 'child':
      return {
        exposedDeviceId: parsed.parentDeviceId,
        deviceId: parsed.childDeviceId,
        requiresParent: parsed.parentDeviceId,
        ownAccess: 'create',
      }
    case 'alarm-panel':
    case 'detection':
    case 'generic':
      return {
        exposedDeviceId: parsed.deviceId,
        deviceId: parsed.deviceId,
        requiresParent: null,
        ownAccess: 'view',
      }
    case 'invalid':
      return null
  }
}

export interface AlexaAccessGateDeps {
  /** Every hub user with its admin flag and scopes (`userManagement.listUsers`). */
  readonly listUserGrants: () => Promise<readonly AlexaUserGrant[]>
  /** One device's selector metadata, `null` when the registry does not know it. */
  readonly getDeviceMeta: (deviceId: number) => Promise<DeviceMetaLike | null>
  readonly logger: IScopedLogger
  readonly now?: () => number
}

interface GrantsSnapshot {
  readonly at: number
  readonly byUserId: ReadonlyMap<string, AlexaUserGrant>
}

interface MetaEntry {
  readonly at: number
  readonly meta: DeviceMetaLike | null
}

export class AlexaAccessGate {
  private grants: GrantsSnapshot | null = null
  private grantsFlight: Promise<GrantsSnapshot> | null = null
  private readonly meta = new Map<number, MetaEntry>()
  private warnedStale = false

  constructor(private readonly deps: AlexaAccessGateDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Resolve the principal a link with this `userId` acts for. */
  async principal(userId: string): Promise<PrincipalLookup> {
    const snapshot = await this.readGrants()
    if (snapshot === null) {
      return { kind: 'unavailable', error: 'the hub user store could not be read' }
    }
    const grant = snapshot.byUserId.get(userId)
    if (grant === undefined) return { kind: 'unknown-user' }
    return { kind: 'found', principal: principalFromGrant(grant) }
  }

  /** Does `principal` reach `deviceId` at `access`? */
  async allows(
    principal: AlexaPrincipal,
    deviceId: number,
    access: MethodAccess,
  ): Promise<AccessVerdict> {
    if (principal.kind === 'admin') return 'allowed'
    const chain = await this.chainOf(deviceId)
    if (chain === null) return 'unknown'
    return principalAllowsDevice(principal, chain, access) ? 'allowed' : 'denied'
  }

  /** The device's parent per the registry; `undefined` when unknown. */
  async parentOf(deviceId: number): Promise<number | null | undefined> {
    const meta = await this.metaOf(deviceId)
    return meta === null ? undefined : meta.parentDeviceId
  }

  /** Forget everything cached — for tests and an operator-driven re-sync. */
  invalidate(): void {
    this.grants = null
    this.meta.clear()
  }

  private async readGrants(): Promise<GrantsSnapshot | null> {
    const cached = this.grants
    if (cached !== null && this.now() - cached.at < USER_GRANTS_TTL_MS) return cached
    if (this.grantsFlight === null) {
      this.grantsFlight = this.deps
        .listUserGrants()
        .then((list) => {
          const byUserId = new Map<string, AlexaUserGrant>()
          for (const g of list) byUserId.set(g.userId, g)
          const snapshot: GrantsSnapshot = { at: this.now(), byUserId }
          this.grants = snapshot
          this.warnedStale = false
          return snapshot
        })
        .finally(() => {
          this.grantsFlight = null
        })
    }
    try {
      return await this.grantsFlight
    } catch (err) {
      if (cached !== null) {
        if (!this.warnedStale) {
          this.warnedStale = true
          this.deps.logger.warn(
            'alexa access: the hub user store could not be re-read — keeping the last good grants',
            { meta: { error: errMsg(err), ageMs: this.now() - cached.at } },
          )
        }
        return cached
      }
      this.deps.logger.warn(
        'alexa access: the hub user store could not be read — refusing Alexa access until it can',
        { meta: { error: errMsg(err) } },
      )
      return null
    }
  }

  private async metaOf(deviceId: number): Promise<DeviceMetaLike | null> {
    const cached = this.meta.get(deviceId)
    if (cached !== undefined && this.now() - cached.at < DEVICE_META_TTL_MS) return cached.meta
    try {
      const meta = await this.deps.getDeviceMeta(deviceId)
      this.meta.set(deviceId, { at: this.now(), meta })
      return meta
    } catch (err) {
      this.deps.logger.debug('alexa access: device metadata read failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return cached?.meta ?? null
    }
  }

  /** The device followed by its ancestors, or `null` if the device is unknown.
   *  An unknown ANCESTOR ends the walk — inheritance through it is simply not
   *  granted (fail closed). */
  private async chainOf(deviceId: number): Promise<DeviceMetaLike[] | null> {
    const self = await this.metaOf(deviceId)
    if (self === null) return null
    const chain: DeviceMetaLike[] = [self]
    let parent = self.parentDeviceId
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS && parent !== null; hop++) {
      if (chain.some((d) => d.id === parent)) break
      const meta = await this.metaOf(parent)
      if (meta === null) break
      chain.push(meta)
      parent = meta.parentDeviceId
    }
    return chain
  }
}
