/**
 * Per-device value catalogs for wireable fields (`status.fieldEnums` on a cap).
 *
 * A status field such as `error.code` or `event-emitter.lastEvent.eventType` is a
 * plain string in the schema, but the device's integration DECLARES the closed set
 * of values at runtime (`error.listFaultTypes`, the event vocabulary). This module
 * asks the device's own provider and returns the values the editor offers as a
 * dropdown. A read that fails answers `null` — the caller leaves `enumValues`
 * absent (free text stays) and logs; it is never an empty list (D393, D315).
 */
import { z } from 'zod'
import type { FieldEnumSource, ICapabilityRegistry, IScopedLogger } from '@dominevo/types'

const RecordSchema = z.record(z.string(), z.unknown())

/** Provider surface the catalog read needs, resolved structurally (no cast). */
type ProviderShape = Readonly<Record<string, unknown>>

function isProviderShape(value: unknown): value is ProviderShape {
  return typeof value === 'object' && value !== null
}

function listOf(answer: unknown, source: FieldEnumSource): string[] | null {
  const record = RecordSchema.safeParse(answer)
  if (!record.success) return null
  const list = z.array(RecordSchema).safeParse(record.data[source.listKey])
  if (!list.success) return null
  const values: string[] = []
  for (const entry of list.data) {
    const value = entry[source.valueKey]
    if (typeof value !== 'string') return null
    if (!values.includes(value)) values.push(value)
  }
  return values
}

async function readAnswer(
  provider: ProviderShape,
  source: FieldEnumSource,
  deviceId: number,
): Promise<unknown> {
  const name = source.from === 'method' ? source.method : 'getStatus'
  const fn = provider[name]
  // A provider without the catalog (another integration) is a quiet absence.
  if (typeof fn !== 'function') return undefined
  return await Reflect.apply(fn, provider, [{ deviceId }])
}

export interface CatalogRead {
  readonly registry: ICapabilityRegistry
  readonly logger: IScopedLogger
  readonly capName: string
  readonly deviceId: number
  readonly path: string
  readonly source: FieldEnumSource
  /** The read is abandoned (field stays free text, one warn) after this many ms. */
  readonly budgetMs: number
}

const TIMED_OUT = Symbol('catalog-read-timed-out')

async function raceBudget(work: Promise<unknown>, budgetMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), budgetMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The device's declared values for one field, or `null` when there are none to
 * offer. A provider without the catalog, a cold (null) slice or an empty catalog
 * is a quiet absence; a thrown read, a timeout or a malformed answer is warned
 * with the device tag. Either way the field stays free text.
 */
export async function readFieldCatalog(read: CatalogRead): Promise<string[] | null> {
  const { registry, logger, capName, deviceId, path, source, budgetMs } = read
  try {
    const provider: unknown = registry.getProviderForDevice(capName, deviceId)
    if (!isProviderShape(provider)) return null
    const answer = await raceBudget(readAnswer(provider, source, deviceId), budgetMs)
    if (answer === TIMED_OUT) {
      logger.warn('wireable field catalog: read timed out, field stays free text', {
        tags: { deviceId },
        meta: { deviceId, capName, path, budgetMs },
      })
      return null
    }
    if (answer === undefined || answer === null) return null
    const values = listOf(answer, source)
    if (values === null) {
      logger.warn('wireable field catalog: answer has an unexpected shape', {
        tags: { deviceId },
        meta: { deviceId, capName, path },
      })
      return null
    }
    return values.length > 0 ? values : null
  } catch (err: unknown) {
    logger.warn('wireable field catalog: read failed, field stays free text', {
      tags: { deviceId },
      meta: { deviceId, capName, path, error: err instanceof Error ? err.message : String(err) },
    })
    return null
  }
}
