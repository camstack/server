/**
 * `device-manager.renderDeviceTemplates` / `checkDeviceTemplates` (D1021): the
 * provider side of the ONE door to the template renderer. The renderer is built
 * on first use (a worker is spawned lazily by it) and disposed at shutdown.
 */
import {
  type DeviceTemplateView,
  type IDeviceManagerProvider,
  type IScopedLogger,
  runtimeFieldUnit,
} from '@camstack/types'
import { DeviceTemplateHost, type TemplateDeviceRow } from './device-template/template-host.js'
import { DeviceTemplateRenderer } from './device-template/template-renderer.js'

type RenderInput = Parameters<IDeviceManagerProvider['renderDeviceTemplates']>[0]
type RenderOutput = Awaited<ReturnType<IDeviceManagerProvider['renderDeviceTemplates']>>
type CheckInput = Parameters<IDeviceManagerProvider['checkDeviceTemplates']>[0]
type CheckOutput = Awaited<ReturnType<IDeviceManagerProvider['checkDeviceTemplates']>>

/** What the actions need from the device-manager addon, beyond the provider context. */
export interface TemplateActionDeps {
  findByAlias(alias: string): Promise<TemplateDeviceRow | null>
  capsOf(deviceId: number): Promise<readonly string[]>
  fetchSlice(deviceId: number, cap: string): Promise<unknown>
}

/** The D944 base unit of a numeric runtime field, from the cap's own schema. */
export const baseUnitOfRuntimeField: NonNullable<DeviceTemplateView['unitOf']> = (cap, path) => {
  const field = path[0]
  if (typeof field !== 'string') return undefined
  return runtimeFieldUnit(cap, field)
}

export class DeviceTemplateActions {
  private renderer: DeviceTemplateRenderer | null = null
  private host: DeviceTemplateHost | null = null

  constructor(
    private readonly logger: IScopedLogger,
    private readonly deps: TemplateActionDeps,
    private readonly makeRenderer: () => DeviceTemplateRenderer = () =>
      new DeviceTemplateRenderer(),
  ) {}

  private hostOf(): DeviceTemplateHost {
    if (this.host === null) {
      this.renderer = this.makeRenderer()
      this.host = new DeviceTemplateHost({
        renderer: this.renderer,
        findByAlias: this.deps.findByAlias,
        capsOf: this.deps.capsOf,
        fetchSlice: this.deps.fetchSlice,
        unitOf: baseUnitOfRuntimeField,
        logger: this.logger.child('templates'),
      })
    }
    return this.host
  }

  async render(input: RenderInput): Promise<RenderOutput> {
    const allowed =
      input.allowedDeviceIds === undefined ? undefined : new Set(input.allowedDeviceIds)
    return { results: await this.hostOf().render(input.templates, allowed) }
  }

  async check(input: CheckInput): Promise<CheckOutput> {
    const allowed =
      input.allowedDeviceIds === undefined ? undefined : new Set(input.allowedDeviceIds)
    const host = this.hostOf()
    const results: CheckOutput['results'] = []
    for (const source of input.templates) {
      const check = await host.check(source, allowed)
      results.push(
        check.ok
          ? {
              ok: true,
              aliases: check.aliases.map((use) => ({
                alias: use.alias,
                deviceId: use.deviceId,
                allowed: use.allowed,
              })),
            }
          : { ok: false, refusal: { reason: check.reason, message: check.message } },
      )
    }
    return { results }
  }

  dispose(): void {
    this.renderer?.dispose()
    this.renderer = null
    this.host = null
  }
}
