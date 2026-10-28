import { z } from 'zod'
import { IrMediumSchema, type IrMedium } from '@camstack/types'
import type { EspServiceInfo } from './esphome-link.js'

/** Medium of a transmitter the override does not name: ESPHome blasters are infrared. */
const DEFAULT_MEDIA: readonly IrMedium[] = ['ir']

/** An integer argument named like this carries the modulation carrier. */
const CARRIER_ARG = /carrier|freq/i

/**
 * One entry of the per-board `irServices` override: `name`, `name:rf`, or
 * `{ name, medium }`. The medium is declared here, never guessed from the
 * service.
 */
const EntrySchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    medium: z.union([IrMediumSchema, z.array(IrMediumSchema).min(1)]).optional(),
  }),
])

const IrServicesSchema = z.union([z.literal('auto'), z.array(EntrySchema)])

export interface IrServiceEntry {
  readonly name: string
  readonly media: readonly IrMedium[]
}

/** `'auto'` = every qualifying service; a list = exactly those (an empty list = none). */
export type IrServicesSetting = 'auto' | readonly IrServiceEntry[]

/** One transmitter child the board will get. */
export interface IrServicePlan {
  readonly name: string
  readonly media: readonly IrMedium[]
  /** The `int[]` argument that receives the pulse train. */
  readonly timingsArg: string
  /** The `int` argument that receives the carrier, when the service has one. */
  readonly carrierArg?: string
}

function entryOf(raw: z.infer<typeof EntrySchema>): IrServiceEntry {
  if (typeof raw === 'string') {
    const at = raw.lastIndexOf(':')
    if (at > 0) {
      const medium = IrMediumSchema.safeParse(raw.slice(at + 1))
      if (medium.success) return { name: raw.slice(0, at), media: [medium.data] }
    }
    return { name: raw, media: DEFAULT_MEDIA }
  }
  const medium = raw.medium
  const media = medium === undefined ? DEFAULT_MEDIA : Array.isArray(medium) ? medium : [medium]
  return { name: raw.name, media }
}

/**
 * Read the stored `irServices` value. Absent and `'auto'` are automatic; a
 * malformed value is `null` so the caller can say so rather than guess.
 */
export function parseIrServices(raw: unknown): IrServicesSetting | null {
  if (raw === undefined) return 'auto'
  const parsed = IrServicesSchema.safeParse(raw)
  if (!parsed.success) return null
  return parsed.data === 'auto' ? 'auto' : parsed.data.map(entryOf)
}

/**
 * The arguments of `service` when it can be driven as a transmitter: one
 * `int[]` for the pulse train, and at most one more argument, an `int` named
 * like a carrier. Anything else cannot be filled in, so it is not a transmitter.
 */
function shapeOf(
  service: EspServiceInfo,
): { readonly timingsArg: string; readonly carrierArg?: string } | null {
  const arrays = service.args.filter((a) => a.type === 'int[]')
  const others = service.args.filter((a) => a.type !== 'int[]')
  const [timings] = arrays
  if (arrays.length !== 1 || timings === undefined) return null
  if (others.length === 0) return { timingsArg: timings.name }
  const [carrier] = others
  if (
    others.length === 1 &&
    carrier !== undefined &&
    carrier.type === 'int' &&
    CARRIER_ARG.test(carrier.name)
  ) {
    return { timingsArg: timings.name, carrierArg: carrier.name }
  }
  return null
}

/**
 * The transmitter children of one board. Pure: the same service list and
 * setting always give the same plan, in the board's service order.
 */
export function planIrServices(
  services: readonly EspServiceInfo[],
  setting: IrServicesSetting,
): IrServicePlan[] {
  const plans: IrServicePlan[] = []
  for (const service of services) {
    const shape = shapeOf(service)
    if (shape === null) continue
    const listed = setting === 'auto' ? undefined : setting.find((e) => e.name === service.name)
    if (setting !== 'auto' && listed === undefined) continue
    plans.push({
      name: service.name,
      media: listed?.media ?? DEFAULT_MEDIA,
      ...shape,
    })
  }
  return plans
}
