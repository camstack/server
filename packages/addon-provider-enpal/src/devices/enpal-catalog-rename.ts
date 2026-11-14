/**
 * House and heat-pump meters used to be created as "Consumption". A restore
 * may replace that default; a name the operator chose stays.
 */
import { errMsg, type IScopedLogger } from '@camstack/types'
import { ENPAL_LEGACY_CONSUMPTION_NAME, findSpec } from '../enpal-catalog.js'

export type CatalogNameWrite =
  | { readonly kind: 'keep' }
  | { readonly kind: 'rename'; readonly name: string; readonly stampUserNamed: boolean }

export interface CatalogNameInput {
  readonly specId: string
  readonly name: string
  readonly userNamed: boolean | undefined
}

/** Keep unless the stored name is still the old catalogue default for this meter. */
export function catalogNameWrite(input: CatalogNameInput): CatalogNameWrite {
  const spec = findSpec(input.specId)
  if (spec === undefined) return { kind: 'keep' }
  if (input.specId !== 'house' && input.specId !== 'heatpump') return { kind: 'keep' }
  if (input.name === spec.name) return { kind: 'keep' }
  if (input.name !== ENPAL_LEGACY_CONSUMPTION_NAME) return { kind: 'keep' }
  return {
    kind: 'rename',
    name: spec.name,
    stampUserNamed: input.userNamed === true,
  }
}

export interface CatalogRenameChild {
  readonly deviceId: number
  readonly specId: string
  readonly name: string
  readonly userNamed: boolean | undefined
}

export interface CatalogRenameInput {
  readonly children: readonly CatalogRenameChild[]
  readonly rename: (deviceId: number, name: string, stampUserNamed: boolean) => Promise<void>
  readonly logger: IScopedLogger
}

/** Rename each child that still carries the old default. Logs every rename. */
export async function renameLegacyCatalogDevices(input: CatalogRenameInput): Promise<void> {
  for (const child of input.children) {
    const decision = catalogNameWrite(child)
    if (decision.kind === 'keep') continue
    try {
      await input.rename(child.deviceId, decision.name, decision.stampUserNamed)
    } catch (err: unknown) {
      input.logger.warn('enpal: could not rename a device still carrying the old catalogue name', {
        tags: { deviceId: child.deviceId },
        meta: { from: child.name, to: decision.name, error: errMsg(err) },
      })
      continue
    }
    input.logger.info('enpal: renamed a device that still had the old catalogue name', {
      tags: { deviceId: child.deviceId },
      meta: { specId: child.specId, from: child.name, to: decision.name },
    })
  }
}
