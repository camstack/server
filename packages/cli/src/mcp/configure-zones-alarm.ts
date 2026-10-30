/**
 * Zones and the alarm panel.
 *
 * `configure_zones` and `configure_alarm` are reads. `configure_zone_upsert`
 * writes one detection zone through `zones.addZone` / `zones.updateZone`
 * (coordinates are fractions of the frame, 0..1). `configure_alarm_set` arms or
 * disarms a panel through `alarmPanel.arm` / `disarm`, and only a panel that
 * takes no PIN: a PIN is a secret, so for a panel that needs one the tool
 * answers `secret-required` and points at the device page — the code never
 * travels through a tool call.
 *
 * Out of scope here, and said so: the on-camera motion mask (`motionZones`)
 * and privacy masks have their own per-device editors with grid and shape
 * semantics; this family reads the motion mask as a summary and does not write it.
 */
import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AlarmArmModeSchema, ZoneKindEnum } from '@camstack/types'
import { text, type DryRunOutcome, type GatedToolSpec, type HubClient } from '@camstack/develop'
import { z } from 'zod'
import {
  ConfirmTokenSchema,
  adminGated,
  adminLink,
  type AdminGatedResult,
} from './configure-common.js'
import type { McpContext, ToolTextResult } from './context.js'
import { readQuery, withHub, type NoSessionResult } from './ops-hub.js'

export const ZONE_UPSERT_TOOL = 'configure_zone_upsert'
export const ALARM_SET_TOOL = 'configure_alarm_set'

const MIN_POLYGON_POINTS = 3
const MIN_TRIPWIRE_POINTS = 2
const DEFAULT_ZONE_COLOR = '#3b82f6'

// ---------------------------------------------------------------------------
// zones

const PointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
})

const StoredZoneSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.string().optional(),
  polygon: z.array(z.looseObject({ x: z.number(), y: z.number() })).optional(),
  color: z.string().optional(),
})
const ZoneListSchema = z.array(StoredZoneSchema)

const MotionStatusSchema = z.looseObject({
  grid: z.array(z.array(z.unknown())).optional(),
})

export async function readZonesTool(
  ctx: McpContext,
  args: { readonly deviceId: number },
): Promise<Record<string, unknown> | NoSessionResult> {
  return withHub(ctx, async ({ client }) => {
    const unavailable: Record<string, string> = {}
    const [zones, motion] = await Promise.all([
      readQuery(client, 'zones.listZones', { deviceId: args.deviceId }, ZoneListSchema),
      readQuery(
        client,
        'motionZones.getStatus',
        { deviceId: args.deviceId },
        MotionStatusSchema.nullable(),
      ),
    ])
    if (!zones.ok) unavailable['zones'] = zones.reason
    if (!motion.ok) unavailable['motionMask'] = motion.reason
    const grid = motion.ok ? motion.value?.grid : undefined
    return {
      status: 'ok' as const,
      deviceId: args.deviceId,
      zones: zones.ok
        ? zones.value.map((zn) => ({
            id: zn.id,
            name: zn.name,
            kind: zn.kind ?? 'polygon',
            points: (zn.polygon ?? []).length,
            polygon: zn.polygon ?? [],
          }))
        : [],
      motionMask: grid
        ? {
            rows: grid.length,
            columns: grid[0]?.length ?? 0,
            cellsDrawn: grid.flat().filter(Boolean).length,
          }
        : null,
      note: 'Zones decide where a detection counts (rules and automations name them). The motion mask is the on-camera area where motion is ignored; it is read here as a summary and edited in the camera page.',
      unavailable,
    }
  })
}

export interface ZoneUpsertArgs {
  readonly deviceId: number
  /** Present = change that zone; absent = add a new one. */
  readonly zoneId?: string
  readonly name: string
  readonly kind: z.infer<typeof ZoneKindEnum>
  readonly points: readonly z.infer<typeof PointSchema>[]
}

export function zoneProblem(args: ZoneUpsertArgs): string | null {
  const need = args.kind === 'tripwire' ? MIN_TRIPWIRE_POINTS : MIN_POLYGON_POINTS
  if (args.points.length < need) return `a ${args.kind} needs at least ${need} points`
  if (args.kind === 'tripwire' && args.points.length > MIN_TRIPWIRE_POINTS * 2) {
    return 'a tripwire is a line: use 2 points (a polyline of a few more is accepted)'
  }
  return null
}

export function zoneUpsertSpec(client: HubClient): GatedToolSpec<ZoneUpsertArgs> {
  return {
    tool: ZONE_UPSERT_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const problem = zoneProblem(args)
      if (problem !== null) return { confirmable: false, describe: { problem } }
      const existing = await readQuery(
        client,
        'zones.listZones',
        { deviceId: args.deviceId },
        ZoneListSchema,
      )
      if (!existing.ok) return { confirmable: false, describe: { problem: existing.reason } }
      const current =
        args.zoneId === undefined ? undefined : existing.value.find((zn) => zn.id === args.zoneId)
      if (args.zoneId !== undefined && current === undefined) {
        return {
          confirmable: false,
          describe: {
            problem: `device ${args.deviceId} has no zone ${args.zoneId}`,
          },
        }
      }
      const clash = existing.value.find(
        (zn) => zn.id !== args.zoneId && zn.name.toLowerCase() === args.name.toLowerCase(),
      )
      if (clash !== undefined) {
        return {
          confirmable: false,
          describe: {
            problem: `a zone named "${clash.name}" already exists (id ${clash.id}); pass zoneId to change it`,
          },
        }
      }
      return {
        confirmable: true,
        describe:
          current === undefined
            ? {
                action: 'add zone',
                deviceId: args.deviceId,
                name: args.name,
                kind: args.kind,
                points: args.points.length,
                note: 'a new id is assigned when it is saved',
              }
            : {
                action: 'change zone',
                deviceId: args.deviceId,
                zoneId: args.zoneId,
                before: {
                  name: current.name,
                  kind: current.kind ?? 'polygon',
                  points: (current.polygon ?? []).length,
                },
                after: {
                  name: args.name,
                  kind: args.kind,
                  points: args.points.length,
                },
              },
      }
    },
    async execute(args) {
      const existing = await readQuery(
        client,
        'zones.listZones',
        { deviceId: args.deviceId },
        ZoneListSchema,
      )
      const keepColor =
        args.zoneId !== undefined && existing.ok
          ? existing.value.find((zn) => zn.id === args.zoneId)?.color
          : undefined
      const zone = {
        id: args.zoneId ?? randomUUID(),
        name: args.name,
        kind: args.kind,
        polygon: args.points.map((p) => ({ x: p.x, y: p.y })),
        color: keepColor ?? DEFAULT_ZONE_COLOR,
      }
      await client.call('POST', args.zoneId === undefined ? 'zones.addZone' : 'zones.updateZone', {
        deviceId: args.deviceId,
        zone,
      })
      return { zoneId: zone.id, name: zone.name }
    },
  }
}

export async function zoneUpsert(
  ctx: McpContext,
  args: ZoneUpsertArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, zoneUpsertSpec, args, confirmToken)
}

// ---------------------------------------------------------------------------
// alarm

const DeviceRowSchema = z.array(
  z.looseObject({ id: z.number(), name: z.string(), type: z.string() }),
)
const PanelStatusSchema = z.looseObject({
  state: z.string(),
  targetMode: z.string().nullish(),
  availableModes: z.array(z.string()),
  requiresCode: z.boolean(),
})

export async function readAlarm(
  ctx: McpContext,
  args: { readonly deviceId?: number },
): Promise<Record<string, unknown> | NoSessionResult> {
  return withHub(ctx, async ({ client }) => {
    const devices = await readQuery(
      client,
      'deviceManager.listAll',
      { projection: 'slim' },
      DeviceRowSchema,
    )
    if (!devices.ok) return { status: 'unavailable' as const, reason: devices.reason }
    const panels = devices.value.filter(
      (d) => d.type === 'alarm-panel' && (args.deviceId === undefined || d.id === args.deviceId),
    )
    if (panels.length === 0) {
      return {
        status: 'ok' as const,
        panels: [],
        note: 'No alarm panel device exists on this hub, so there is nothing to arm or disarm.',
      }
    }
    const rows = await Promise.all(
      panels.map(async (p) => {
        const status = await readQuery(
          client,
          'alarmPanel.getStatus',
          { deviceId: p.id },
          PanelStatusSchema.nullable(),
        )
        return status.ok && status.value !== null
          ? {
              deviceId: p.id,
              name: p.name,
              state: status.value.state,
              mode: status.value.targetMode ?? null,
              availableModes: status.value.availableModes,
              requiresCode: status.value.requiresCode,
            }
          : {
              deviceId: p.id,
              name: p.name,
              unavailable: status.ok ? 'no status yet' : status.reason,
            }
      }),
    )
    return {
      status: 'ok' as const,
      panels: rows,
      next: `Arm or disarm with ${ALARM_SET_TOOL}; a panel that needs a PIN cannot be driven from here.`,
    }
  })
}

export interface AlarmSetArgs {
  readonly deviceId: number
  readonly action: 'arm' | 'disarm'
  readonly mode?: z.infer<typeof AlarmArmModeSchema>
}

export function alarmSetSpec(client: HubClient): GatedToolSpec<AlarmSetArgs> {
  return {
    tool: ALARM_SET_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const status = await readQuery(
        client,
        'alarmPanel.getStatus',
        { deviceId: args.deviceId },
        PanelStatusSchema.nullable(),
      )
      if (!status.ok) return { confirmable: false, describe: { problem: status.reason } }
      if (status.value === null)
        return {
          confirmable: false,
          describe: {
            problem: `device ${args.deviceId} is not an alarm panel`,
          },
        }
      if (status.value.requiresCode) {
        const link = await adminLink(client, `/devices/${args.deviceId}`)
        return {
          confirmable: false,
          describe: {
            status: 'secret-required',
            field: 'code',
            reason: 'this panel needs a PIN to arm or disarm; a PIN is never a tool argument',
            how:
              link.url !== null
                ? [`open ${link.url} and use the alarm panel there`]
                : ['use the alarm panel on the device page of the admin UI'],
          },
        }
      }
      if (args.action === 'arm') {
        if (args.mode === undefined)
          return {
            confirmable: false,
            describe: {
              problem: `pick a mode: ${status.value.availableModes.join(', ')}`,
            },
          }
        if (!status.value.availableModes.includes(args.mode)) {
          return {
            confirmable: false,
            describe: {
              problem: `this panel does not take "${args.mode}" (it takes: ${status.value.availableModes.join(', ')})`,
            },
          }
        }
      }
      return {
        confirmable: true,
        describe: {
          action: args.action === 'arm' ? `arm the panel (${args.mode})` : 'disarm the panel',
          deviceId: args.deviceId,
          before: {
            state: status.value.state,
            mode: status.value.targetMode ?? null,
          },
          effect:
            args.action === 'arm'
              ? 'sensors start to trigger the alarm'
              : 'the alarm stops reacting to sensors',
        },
      }
    },
    async execute(args) {
      if (args.action === 'arm') {
        await client.call('POST', 'alarmPanel.arm', {
          deviceId: args.deviceId,
          mode: args.mode,
        })
      } else {
        await client.call('POST', 'alarmPanel.disarm', {
          deviceId: args.deviceId,
        })
      }
      return { deviceId: args.deviceId, action: args.action }
    },
  }
}

export async function alarmSet(
  ctx: McpContext,
  args: AlarmSetArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, alarmSetSpec, args, confirmToken)
}

const GATE_HOW =
  'Two steps: call without confirm_token for a preview and a one-shot token, then call again with the SAME arguments and that token. Needs an admin `camstack login` session.'

export function registerZonesAlarmTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'configure_zones',
    'Read the detection zones drawn on one camera (id, name, kind, points, normalised 0..1) and a summary of its motion mask. Writes nothing.',
    { deviceId: z.number().int().nonnegative() },
    async ({ deviceId }): Promise<ToolTextResult> => text(await readZonesTool(ctx, { deviceId })),
  )
  server.tool(
    ZONE_UPSERT_TOOL,
    `Add a detection zone to a camera, or change one (zoneId). Points are fractions of the frame, 0..1, x to the right and y downward; a polygon needs 3 or more, a tripwire 2. ${GATE_HOW}`,
    {
      deviceId: z.number().int().nonnegative(),
      zoneId: z.string().min(1).optional(),
      name: z.string().min(1).max(80),
      kind: ZoneKindEnum.default('polygon'),
      points: z.array(PointSchema).min(2).max(64),
      confirm_token: ConfirmTokenSchema,
    },
    async ({ deviceId, zoneId, name, kind, points, confirm_token }): Promise<ToolTextResult> =>
      text(
        await zoneUpsert(
          ctx,
          {
            deviceId,
            ...(zoneId !== undefined ? { zoneId } : {}),
            name,
            kind,
            points,
          },
          confirm_token,
        ),
      ),
  )
  server.tool(
    'configure_alarm',
    'Read the alarm panels of the hub: state, armed mode, the modes each accepts and whether it needs a PIN. Writes nothing.',
    { deviceId: z.number().int().nonnegative().optional() },
    async ({ deviceId }): Promise<ToolTextResult> =>
      text(await readAlarm(ctx, deviceId !== undefined ? { deviceId } : {})),
  )
  server.tool(
    ALARM_SET_TOOL,
    `Arm (with a mode) or disarm an alarm panel that takes no PIN. A panel that needs a PIN answers secret-required and points at the admin UI. ${GATE_HOW}`,
    {
      deviceId: z.number().int().nonnegative(),
      action: z.enum(['arm', 'disarm']),
      mode: AlarmArmModeSchema.optional(),
      confirm_token: ConfirmTokenSchema,
    },
    async ({ deviceId, action, mode, confirm_token }): Promise<ToolTextResult> =>
      text(
        await alarmSet(
          ctx,
          { deviceId, action, ...(mode !== undefined ? { mode } : {}) },
          confirm_token,
        ),
      ),
  )
}
