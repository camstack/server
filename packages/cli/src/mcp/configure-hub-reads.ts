/**
 * The hub reads the interview tools ask while they build a recipe or a rule:
 * zones of a camera, the wireable fields of a device, the caps bound to a
 * device, the notification targets. Each is a validated GET that answers with a
 * reason when it fails — an interview never treats "could not read" as "none".
 */
import type { HubClient } from '@camstack/develop'
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

const TargetListSchema = z.array(
  z.looseObject({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    enabled: z.boolean().optional(),
  }),
)

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
  const read = await readQuery(client, 'notificationOutput.listTargets', {}, TargetListSchema)
  if (!read.ok) return read
  return {
    ok: true,
    value: read.value.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      enabled: t.enabled !== false,
    })),
  }
}
