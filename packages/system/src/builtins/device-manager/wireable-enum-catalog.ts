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
import type { FieldEnumSource, ICapabilityRegistry, IScopedLogger } from '@camstack/types'

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
  if (typeof fn !== 'function') throw new Error(`provider has no ${name}`)
  return await Reflect.apply(fn, provider, [{ deviceId }])
}

export interface CatalogRead {
  readonly registry: ICapabilityRegistry
  readonly logger: IScopedLogger
  readonly capName: string
  readonly deviceId: number
  readonly path: string
  readonly source: FieldEnumSource
}

/**
 * The device's declared values for one field, or `null` when they could not be
 * read (logged with the device tag) or the device declares none.
 */
export async function readFieldCatalog(read: CatalogRead): Promise<string[] | null> {
  const { registry, logger, capName, deviceId, path, source } = read
  try {
    const provider: unknown = registry.getProviderForDevice(capName, deviceId)
    if (!isProviderShape(provider)) {
      logger.warn('wireable field catalog: no provider answers for the device', {
        tags: { deviceId },
        meta: { deviceId, capName, path },
      })
      return null
    }
    const values = listOf(await readAnswer(provider, source, deviceId), source)
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
