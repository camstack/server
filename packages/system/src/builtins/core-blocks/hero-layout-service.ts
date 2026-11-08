/**
 * The `hero-layout` provider of core-blocks (D1023): serves the FIXED layouts
 * and the built hero model. Read-only — it stores nothing and edits nothing.
 *
 * `getHeroModel` reads the device, its bindings (per device, D12) and one slice
 * per bound cap through an injected reader, then hands everything to the pure
 * `buildHeroModel`. A slice that cannot be read is simply absent: the model
 * says "not answered", never "off" (D315/D393). The remote's saved command
 * count comes from the remote cap and is `null` when it cannot be asked.
 */
import {
  buildHeroModel,
  type HeroRowModel,
  projectDeviceRow,
  type IHeroLayoutProvider,
  type IScopedLogger,
  resolveHeroLayout,
} from '@camstack/types'

/** What the registry says about the device. */
export interface HeroDeviceFacts {
  readonly type: string
  readonly role: string | null
  readonly name: string
  readonly online: boolean
  readonly features: readonly string[]
  /** The brand or integration name the device comes from, when it is known. */
  readonly integration?: string | null
}

/** The reads the service needs; the addon wires them to `ctx.api`. */
export interface HeroLayoutReader {
  /** The device facts, or null when the registry does not know it. */
  readonly device: (deviceId: number) => Promise<HeroDeviceFacts | null>
  /** Kebab cap names the device is bound to. */
  readonly caps: (deviceId: number) => Promise<readonly string[]>
  /** The raw slice of one cap on the device; throws when it cannot be read. */
  readonly slice: (deviceId: number, capName: string) => Promise<unknown>
  /** Saved remote commands; throws when the remote cannot be asked. */
  readonly remoteCommands: (deviceId: number) => Promise<number>
}

export interface HeroLayoutServiceDeps {
  readonly reader: HeroLayoutReader
  readonly logger: IScopedLogger
  readonly now: () => number
}

const REMOTE_CAP = 'remote'

/** Models built at once for a list; the cap bounds the list, this bounds the fan-out on the registry. */
const ROW_MODELS_CONCURRENCY = 16

export class HeroLayoutService implements IHeroLayoutProvider {
  constructor(private readonly deps: HeroLayoutServiceDeps) {}

  readonly getLayout: IHeroLayoutProvider['getLayout'] = async ({ deviceType }) => ({
    type: deviceType,
    rows: [...resolveHeroLayout(deviceType).rows],
  })

  readonly getHeroModel: IHeroLayoutProvider['getHeroModel'] = async ({ deviceId, canActuate }) => {
    const { reader, logger } = this.deps
    const device = await reader.device(deviceId)
    if (device === null) {
      logger.warn('hero model: device not found', { tags: { deviceId } })
      return null
    }
    const bound = await reader.caps(deviceId)
    const slices: Record<string, unknown> = {}
    await Promise.all(
      bound
        .filter((cap) => cap !== REMOTE_CAP)
        .map(async (cap) => {
          try {
            slices[cap] = await reader.slice(deviceId, cap)
          } catch (error) {
            logger.warn('hero model: a cap slice could not be read; drawn as not answered', {
              tags: { deviceId },
              meta: { cap, error: error instanceof Error ? error.message : String(error) },
            })
          }
        }),
    )
    const remoteCommands = await this.remoteCommands(deviceId)
    return buildHeroModel({
      device: {
        id: deviceId,
        type: device.type,
        role: device.role,
        name: device.name,
        online: device.online,
        integration: device.integration ?? null,
      },
      // The remote is a system cap, never in `getBindings`: it is offered to any
      // type, and its contribution decides (0 commands = no button, unknown = a button).
      caps: [...bound.filter((cap) => cap !== REMOTE_CAP), REMOTE_CAP],
      features: device.features,
      slices,
      now: this.deps.now(),
      remoteCommands,
      access: { canActuate: canActuate ?? true },
    })
  }

  /**
   * One row per requested id, in order. `null` means "no row": either the registry
   * does not know the device, or reading it failed (logged, tagged). Both read as
   * "unknown", never as an empty row. A repeated id is read once.
   */
  readonly getRowModels: IHeroLayoutProvider['getRowModels'] = async ({
    deviceIds,
    canActuate,
  }) => {
    const unique = [...new Set(deviceIds)]
    const byId = new Map<number, HeroRowModel | null>()
    for (let from = 0; from < unique.length; from += ROW_MODELS_CONCURRENCY) {
      const chunk = unique.slice(from, from + ROW_MODELS_CONCURRENCY)
      const rows = await Promise.all(chunk.map((id) => this.rowOf(id, canActuate)))
      chunk.forEach((id, i) => byId.set(id, rows[i] ?? null))
    }
    return deviceIds.map((id) => byId.get(id) ?? null)
  }

  private async rowOf(
    deviceId: number,
    canActuate: boolean | undefined,
  ): Promise<HeroRowModel | null> {
    try {
      const model = await this.getHeroModel({ deviceId, canActuate })
      return model === null ? null : projectDeviceRow(model)
    } catch (error) {
      this.deps.logger.warn('hero row: the device could not be read; its row is absent', {
        tags: { deviceId },
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
      return null
    }
  }

  private async remoteCommands(deviceId: number): Promise<number | null> {
    try {
      return await this.deps.reader.remoteCommands(deviceId)
    } catch (error) {
      this.deps.logger.warn(
        'hero model: the remote could not be asked; its button shows without a count',
        {
          tags: { deviceId },
          meta: { error: error instanceof Error ? error.message : String(error) },
        },
      )
      return null
    }
  }
}
