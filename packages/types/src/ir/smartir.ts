import { z } from 'zod'
import { IrCodecError } from './ir-error.js'
import { IrTimingsSchema } from './ir-timings.js'
import type { IrPayload } from './ir-payload.js'
import { decodePronto } from './pronto.js'

export type RemoteCommandGroup = 'command' | 'source'

export interface RemoteCommand {
  name: string
  group: RemoteCommandGroup
  payload: IrPayload
  /** Overrides the remote's default transmitter for this command. */
  transmitterDeviceId?: number
}

export interface RemoteCommandTableOrigin {
  format: 'smartir'
  manufacturer?: string
  models?: string[]
  controller?: string
}

export interface RemoteCommandTable {
  commands: RemoteCommand[]
  interCommandDelayMs: number
  origin?: RemoteCommandTableOrigin
}

export interface SkippedCommand {
  name: string
  group: RemoteCommandGroup
  reason: string
}

export interface SmartIrParseResult {
  table: RemoteCommandTable
  skipped: SkippedCommand[]
}

/** SmartIR's own default pause between two commands, in seconds. */
const DEFAULT_DELAY_S = 0.5
const SOURCES_KEY = 'sources'

const SmartIrDocumentSchema = z.object({
  manufacturer: z.string().optional(),
  supportedModels: z.array(z.string()).optional(),
  supportedController: z.string().optional(),
  commandsEncoding: z.string(),
  delay: z.number().nonnegative().optional(),
  commands: z.record(z.string(), z.unknown()),
})

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function rawPayload(value: string): IrPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new IrCodecError('invalid-raw', `Raw command is not a JSON array: ${describe(error)}`)
  }
  const checked = IrTimingsSchema.safeParse(parsed)
  if (!checked.success) {
    throw new IrCodecError('invalid-timings', checked.error.message)
  }
  return { kind: 'raw', timings: checked.data }
}

function prontoPayload(value: string): IrPayload {
  decodePronto(value)
  return { kind: 'pronto', code: value }
}

/** Parse a SmartIR media_player JSON. Raw and Pronto are imported; other encodings are reported in `skipped`. */
export function parseSmartIr(document: unknown): SmartIrParseResult {
  const parsed = SmartIrDocumentSchema.safeParse(document)
  if (!parsed.success) {
    throw new IrCodecError('smartir-malformed', `Not a SmartIR document: ${parsed.error.message}`)
  }
  const doc = parsed.data
  const encoding = doc.commandsEncoding
  const entries: Array<{ name: string; group: RemoteCommandGroup; value: unknown }> = []
  for (const [name, value] of Object.entries(doc.commands)) {
    if (
      name === SOURCES_KEY &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      for (const [sourceName, sourceValue] of Object.entries(value)) {
        entries.push({ name: sourceName, group: 'source', value: sourceValue })
      }
    } else {
      entries.push({ name, group: 'command', value })
    }
  }

  const commands: RemoteCommand[] = []
  const skipped: SkippedCommand[] = []
  const supported = encoding === 'Raw' || encoding === 'Pronto'
  for (const { name, group, value } of entries) {
    if (!supported) {
      skipped.push({ name, group, reason: `${encoding} encoding is not supported` })
      continue
    }
    if (typeof value !== 'string') {
      skipped.push({ name, group, reason: 'command is not a string' })
      continue
    }
    try {
      commands.push({
        name,
        group,
        payload: encoding === 'Raw' ? rawPayload(value) : prontoPayload(value),
      })
    } catch (error) {
      skipped.push({ name, group, reason: describe(error) })
    }
  }

  return {
    table: {
      commands,
      interCommandDelayMs: Math.round((doc.delay ?? DEFAULT_DELAY_S) * 1000),
      origin: {
        format: 'smartir',
        manufacturer: doc.manufacturer,
        models: doc.supportedModels,
        controller: doc.supportedController,
      },
    },
    skipped,
  }
}
