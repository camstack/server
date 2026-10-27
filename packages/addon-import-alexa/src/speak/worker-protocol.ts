/** Line-delimited JSON the long-lived Python worker speaks. One object per line. */
import { z } from 'zod'
import { ALEXA_REGIONS, SPEAK_MODES } from './constants.js'

export const EchoDeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  family: z.string(),
  online: z.boolean(),
  kind: z.enum(['device', 'group']),
  dnd: z.boolean(),
  deviceType: z.string(),
  /** The room the account files the device under, when Amazon names one. */
  room: z.string().optional(),
})
export type EchoDevice = z.infer<typeof EchoDeviceSchema>

export const LoginStatusSchema = z.enum(['ok', 'failed'])
export type LoginStatus = z.infer<typeof LoginStatusSchema>

export const SessionStatusSchema = z.object({
  loggedIn: z.boolean(),
  ageSec: z.number().int().nonnegative(),
  lastSuccessAt: z.number().int().nullable(),
})
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const TargetDeliverySchema = z.object({
  targetId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
})
export type TargetDelivery = z.infer<typeof TargetDeliverySchema>

const WorkerOkSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  result: z.unknown().optional(),
})

const WorkerErrSchema = z.object({
  id: z.string(),
  ok: z.literal(false),
  error: z.string(),
})

export const WorkerLineSchema = z.union([WorkerOkSchema, WorkerErrSchema])
export type WorkerLine = z.infer<typeof WorkerLineSchema>

export type WorkerRequest =
  | {
      /**
       * Sign in as the broker's Amazon account. `refreshTokenPath` names an
       * owner-only file with the broker's refresh token ('' when the broker has
       * none, so only the stored `sessionPath` jar can be tried).
       */
      readonly op: 'login_broker'
      readonly label: string
      readonly refreshTokenPath: string
      readonly deviceAppName: string
      readonly domain: string
      readonly sessionPath: string
      readonly region: (typeof ALEXA_REGIONS)[number]
    }
  | { readonly op: 'devices' }
  | {
      readonly op: 'speak' | 'announce'
      readonly targets: readonly string[]
      readonly text: string
      readonly volume: number
    }
  | { readonly op: 'session_status' }

export function requestLine(id: string, request: WorkerRequest): string {
  return `${JSON.stringify({ id, ...request })}\n`
}

export interface LoginStartResult {
  readonly status: LoginStatus
  readonly error?: string
}

export function parseLoginResult(result: unknown): LoginStartResult {
  const parsed = z
    .object({ status: LoginStatusSchema, error: z.string().optional() })
    .safeParse(result)
  if (!parsed.success)
    return { status: 'failed', error: 'worker returned an unexpected login result' }
  return parsed.data
}

export function parseDevices(result: unknown): readonly EchoDevice[] {
  const parsed = z.object({ devices: z.array(EchoDeviceSchema) }).safeParse(result)
  if (!parsed.success) throw new Error('worker returned an unexpected device list')
  return parsed.data.devices
}

export function parseDeliveries(result: unknown): readonly TargetDelivery[] {
  const parsed = z.object({ outcomes: z.array(TargetDeliverySchema) }).safeParse(result)
  if (!parsed.success) throw new Error('worker returned an unexpected delivery list')
  return parsed.data.outcomes
}

export function parseSessionStatus(result: unknown): SessionStatus {
  const parsed = SessionStatusSchema.safeParse(result)
  if (!parsed.success) throw new Error('worker returned an unexpected session status')
  return parsed.data
}

export function isSpeakOp(mode: (typeof SPEAK_MODES)[number]): 'speak' | 'announce' {
  return mode === 'announce' ? 'announce' : 'speak'
}
