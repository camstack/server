/**
 * The line protocol of `python/unifi_worker.py` (aiounifi): one JSON request per stdin line,
 * one JSON answer per stdout line matched by `id`, plus unsolicited `push` lines. Every line is
 * parsed here; a failure answer becomes the typed error the connection test already names.
 */
import { z } from 'zod'
import {
  UnifiApiError,
  UnifiAuthError,
  UnifiMfaRequiredError,
  UnifiSiteNotFoundError,
  UnifiUnreachableError,
} from './unifi-errors.js'

/** A request the worker serves. `passwordFile` is the PATH of an owner-only file, never the value. */
export type UnifiWorkerRequest =
  | {
      readonly op: 'connect'
      readonly host: string
      readonly port: number
      readonly site: string
      readonly username: string
      readonly passwordFile: string
      readonly allowSelfSigned: boolean
    }
  | { readonly op: 'list'; readonly refresh: boolean }
  | {
      readonly op: 'set_poe'
      readonly deviceId: string
      readonly portIdx: number
      readonly on: boolean
    }
  | { readonly op: 'set_led'; readonly deviceId: string; readonly on: boolean }
  | { readonly op: 'restart'; readonly deviceId: string }
  | {
      readonly op: 'power_cycle'
      readonly deviceId: string
      readonly portIdx: number
    }
  | { readonly op: 'disconnect' }

export function requestLine(id: string, request: UnifiWorkerRequest): string {
  return JSON.stringify({ id, ...request }) + '\n'
}

const nullableNumber = z.number().nullable()

export const workerPortSchema = z.object({
  idx: z.number(),
  poeCapable: z.boolean(),
  poeOn: z.boolean(),
  poeMode: z.string().nullable(),
  linkUp: z.boolean().nullable(),
  speedMbps: nullableNumber,
  poePowerW: nullableNumber,
  poeVoltageV: nullableNumber,
  poeCurrentA: nullableNumber,
  clientMac: z.string().nullable(),
  clientName: z.string().nullable(),
})

export const workerDeviceSchema = z.object({
  id: z.string(),
  mac: z.string().nullable(),
  name: z.string(),
  model: z.string(),
  type: z.string().nullable(),
  state: z.number().nullable(),
  uptimeSec: nullableNumber,
  cpuPercent: nullableNumber,
  memoryPercent: nullableNumber,
  cpuTempC: nullableNumber,
  clients: z.number(),
  ledOverride: z.string().nullable(),
  ports: z.array(workerPortSchema),
})
export type UnifiWorkerDevice = z.infer<typeof workerDeviceSchema>

export const workerClientSchema = z.object({
  mac: z.string(),
  hostname: z.string(),
  ip: z.string().nullable(),
})
export type UnifiWorkerClient = z.infer<typeof workerClientSchema>

export const workerTablesSchema = z.object({
  devices: z.array(workerDeviceSchema),
  clients: z.array(workerClientSchema),
})
export type UnifiWorkerTables = z.infer<typeof workerTablesSchema>

export const workerConnectResultSchema = z.object({ site: z.string() })

const failureKind = z.enum([
  'auth',
  'mfa',
  'unreachable',
  'tls',
  'site-not-found',
  'not-connected',
  'not-found',
  'api',
  'bad-request',
])
export type UnifiWorkerFailureKind = z.infer<typeof failureKind>

export const workerAnswerSchema = z.union([
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.string(),
    ok: z.literal(false),
    kind: failureKind,
    error: z.string(),
    site: z.string().optional(),
    available: z.array(z.string()).optional(),
  }),
])
export type UnifiWorkerAnswer = z.infer<typeof workerAnswerSchema>
export type UnifiWorkerFailureAnswer = Extract<UnifiWorkerAnswer, { ok: false }>

export const workerPushSchema = z.discriminatedUnion('push', [
  z.object({
    push: z.literal('snapshot'),
    devices: z.array(workerDeviceSchema),
    clients: z.array(workerClientSchema),
  }),
  z.object({
    push: z.literal('channel'),
    state: z.enum(['up', 'down', 'failed']),
    reason: z.string().optional(),
    retryInMs: z.number().optional(),
  }),
])
export type UnifiWorkerPush = z.infer<typeof workerPushSchema>

/** The worker is alive but holds no signed-in controller (it restarted): sign in again. */
export class UnifiWorkerNotConnectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnifiWorkerNotConnectedError'
  }
}

/** The typed error a failure answer stands for. */
export function workerFailureError(answer: UnifiWorkerFailureAnswer): Error {
  switch (answer.kind) {
    case 'auth':
      return new UnifiAuthError(answer.error)
    case 'mfa':
      return new UnifiMfaRequiredError()
    case 'unreachable':
      return new UnifiUnreachableError(answer.error, false)
    case 'tls':
      return new UnifiUnreachableError(answer.error, true)
    case 'site-not-found':
      return new UnifiSiteNotFoundError(answer.site ?? '', answer.available ?? [])
    case 'not-connected':
      return new UnifiWorkerNotConnectedError(answer.error)
    case 'not-found':
      return new UnifiApiError(404, answer.error)
    case 'bad-request':
      return new UnifiApiError(400, answer.error)
    case 'api':
      return new UnifiApiError(0, answer.error)
  }
}
