/**
 * The hub reads the interview tools ask while they build a recipe or a rule:
 * zones of a camera, the wireable fields of a device, the caps bound to a
 * device, the notification targets. Each is a validated GET that answers with a
 * reason when it fails — an interview never treats "could not read" as "none".
 */
import type { HubClient } from '@camstack/develop'
import { notificationTargetKindOf } from '@camstack/types'
import { z } from 'zod'
import { readQuery, type Read } from './ops-hub.js'

const ZoneListSchema = z.array(
  z.looseObject({
    id: z.string(),
    name: z.string(),
    kind: z.string().optional(),
  }),
)

export interface ZoneRef {
  readonly id: string
  readonly name: string
}

/** The detection zones drawn on one camera (`zones.listZones`). */
export async function readZones(
  client: HubClient,
  deviceId: number,
): Promise<Read<readonly ZoneRef[]>> {
  const read = await readQuery(client, 'zones.listZones', { deviceId }, ZoneListSchema)
  if (!read.ok) return read
  return {
    ok: true,
    value: read.value.map((zn) => ({ id: zn.id, name: zn.name })),
  }
}

const WireableSchema = z.looseObject({
  caps: z.array(
    z.looseObject({
      cap: z.string(),
      fields: z.array(
        z.looseObject({
          path: z.string(),
          kind: z.enum(['string', 'number', 'boolean', 'enum']),
          enumValues: z.array(z.string()).optional(),
          quantity: z.string().optional(),
        }),
      ),
    }),
  ),
})

export interface WireableField {
  readonly cap: string
  readonly path: string
  readonly kind: 'string' | 'number' | 'boolean' | 'enum'
  readonly enumValues?: readonly string[]
  readonly quantity?: string
}

/** Every `cap.field` a device can be compared on (`deviceManager.getWireableFields`). */
export async function readWireableFields(
  client: HubClient,
  deviceId: number,
): Promise<Read<readonly WireableField[]>> {
  const read = await readQuery(
    client,
    'deviceManager.getWireableFields',
    { deviceId },
    WireableSchema,
  )
  if (!read.ok) return read
  const fields: WireableField[] = []
  for (const cap of read.value.caps) {
    for (const f of cap.fields) {
      fields.push({
        cap: cap.cap,
        path: f.path,
        kind: f.kind,
        ...(f.enumValues !== undefined ? { enumValues: f.enumValues } : {}),
        ...(f.quantity !== undefined ? { quantity: f.quantity } : {}),
      })
    }
  }
  return { ok: true, value: fields }
}

const BindingsSchema = z.looseObject({
  entries: z.array(z.looseObject({ capName: z.string() })),
})

/** The caps a device is bound to (`deviceManager.getBindings`). */
export async function readBoundCaps(
  client: HubClient,
  deviceId: number,
): Promise<Read<readonly string[]>> {
  const read = await readQuery(client, 'deviceManager.getBindings', { deviceId }, BindingsSchema)
  if (!read.ok) return read
  return { ok: true, value: read.value.entries.map((e) => e.capName) }
}

const NOTIFICATION_OUTPUT_CAP = 'notification-output'

const ProvidersSchema = z.looseObject({ providers: z.array(z.string()) }).nullable()

const DescriptionSchema = z.looseObject({
  kinds: z.array(z.looseObject({ id: z.string(), functionCap: z.string().optional() })).optional(),
})

const InstanceListSchema = z.array(
  z.looseObject({
    id: z.string(),
    name: z.string(),
    kind: z.string().optional(),
    enabled: z.boolean().optional(),
    formValues: z.record(z.string(), z.unknown()),
  }),
)

/** One notification target as an instance of `notification-output` (a secret is a view, never text). */
export interface NotificationInstance {
  readonly id: string
  readonly name: string
  /** The adapter kind (`telegram`), not the record kind (`notify-telegram`). */
  readonly kind: string
  readonly addonId: string
  readonly enabled: boolean
  /** The form values without the entry's own `name` / `enabled`. */
  readonly config: { readonly [key: string]: unknown }
}

/**
 * Every instance of `notification-output`, through `integration-instances` of each provider. One
 * holder that cannot answer fails the whole read: a partial list is never "no such target" (D315).
 */
export async function readNotificationInstances(
  client: HubClient,
): Promise<Read<readonly NotificationInstance[]>> {
  const providers = await readQuery(
    client,
    'capabilities.getCapability',
    { name: NOTIFICATION_OUTPUT_CAP },
    ProvidersSchema,
  )
  if (!providers.ok) return providers
  if (providers.value === null) {
    return { ok: false, reason: 'the capability registry did not answer for notification-output' }
  }
  const found: NotificationInstance[] = []
  for (const addonId of providers.value.providers) {
    const description = await readQuery(
      client,
      'integrationInstances.describe',
      { addonId },
      DescriptionSchema,
    )
    if (!description.ok) return description
    const kinds = (description.value.kinds ?? []).filter(
      (k) => k.functionCap === NOTIFICATION_OUTPUT_CAP,
    )
    if (kinds.length === 0) continue
    const list = await readQuery(
      client,
      'integrationInstances.listInstances',
      { addonId },
      InstanceListSchema,
    )
    if (!list.ok) return list
    for (const instance of list.value) {
      if (!kinds.some((k) => k.id === instance.kind)) continue
      const { name: _name, enabled: _enabled, ...config } = instance.formValues
      found.push({
        id: instance.id,
        name: instance.name,
        kind: notificationTargetKindOf(instance.kind ?? ''),
        addonId,
        enabled: instance.enabled !== false,
        config,
      })
    }
  }
  return { ok: true, value: found }
}

export interface TargetRef {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly enabled: boolean
}

/**
 * Notification targets, id / name / kind only. A target's `config` holds
 * addresses and chat ids; it is never read into a tool answer.
 */
export async function readTargets(client: HubClient): Promise<Read<readonly TargetRef[]>> {
  const read = await readNotificationInstances(client)
  if (!read.ok) return read
  return {
    ok: true,
    value: read.value.map((t) => ({ id: t.id, name: t.name, kind: t.kind, enabled: t.enabled })),
  }
}
