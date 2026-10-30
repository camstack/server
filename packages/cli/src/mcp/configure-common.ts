/**
 * What every `configure` tool of the P3b families shares: the admin-tier gate
 * (a write needs an admin session and the two-step dry run), the camera list
 * and the admin-UI link. A tool in this family never writes anywhere but
 * through an existing cap method with its own Zod schema; this file adds no
 * path of its own.
 */
import { runGated, type GatedResult, type GatedToolSpec, type HubClient } from '@camstack/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { resolveLinkBase } from './ops-events.js'
import {
  noSessionResult,
  readQuery,
  withHub,
  type NoSessionResult,
  type Read,
  type RefusedResult,
} from './ops-hub.js'

export type AdminGatedResult = GatedResult | NoSessionResult | RefusedResult

/** `confirm_token`, the second step of every gated tool. */
export const ConfirmTokenSchema = z.string().optional()

/**
 * Drive one gated write. Resolves the hub, refuses a credential that is not
 * admin-scoped (the dry run would otherwise promise something `execute` cannot
 * do), then runs the spec through the mutation gate.
 */
export async function adminGated<A>(
  ctx: McpContext,
  makeSpec: (client: HubClient) => GatedToolSpec<A>,
  args: A,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  const outcome = await ctx.hub()
  if (!outcome.ok) return noSessionResult(outcome)
  if (outcome.connection.tier !== 'admin') {
    return {
      status: 'refused',
      reason: outcome.connection.adminHint ?? 'this credential is not admin-scoped',
    }
  }
  return runGated(ctx.gate, makeSpec(outcome.connection.client), args, confirmToken)
}

const CameraListSchema = z.array(
  z.looseObject({
    id: z.number(),
    name: z.string(),
    disabled: z.boolean().optional(),
  }),
)

export interface CameraRef {
  readonly id: number
  readonly name: string
}

/** Every camera of the hub, by id and name. A failed read is a reason, never an empty list. */
export async function readCameras(client: HubClient): Promise<Read<readonly CameraRef[]>> {
  const read = await readQuery(
    client,
    'deviceManager.listAll',
    { projection: 'slim', isCamera: true },
    CameraListSchema,
  )
  if (!read.ok) return read
  return {
    ok: true,
    value: read.value.map((d) => ({ id: d.id, name: d.name })),
  }
}

/** A deep link into the admin UI on the address flagged for app connections, or null with why. */
export async function adminLink(
  client: HubClient,
  path: string,
): Promise<{ readonly url: string | null; readonly reason?: string }> {
  const link = await resolveLinkBase(client)
  if (link.base === null) {
    return {
      url: null,
      ...(link.reason !== undefined ? { reason: link.reason } : {}),
    }
  }
  return { url: `${link.base}${path}` }
}

export { readQuery, withHub }
export type { NoSessionResult, Read }
