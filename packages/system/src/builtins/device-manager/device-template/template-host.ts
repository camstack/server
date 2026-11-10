/**
 * The hub side of device value templates (D1021 run-time contract): the one
 * place a consumer's template becomes text. It names the devices a template
 * refers to (aliases), refuses the ones the caller was not proven to see,
 * fills a `ConditionMirror` with the slices those devices hold NOW, and hands
 * the renderer a resolver over that mirror. A consumer (an action step, a
 * scheduler point, a notification rule, a generated automation block) reaches
 * it only through `device-manager.renderDeviceTemplates`; there is no second
 * renderer and no second copy of the state.
 */
import {
  ConditionMirror,
  DEVICE_TEMPLATE_NOW_ALIAS,
  DEVICE_TEMPLATE_THIS_ALIAS,
  DEVICE_TEMPLATE_VALUES_CAP,
  type DeviceTemplateRefusalReason,
  type DeviceTemplateRender,
  type DeviceTemplateThisDevice,
  type DeviceTemplateView,
  type IScopedLogger,
} from '@camstack/types'
import {
  mirrorTemplateResolver,
  type TemplateDeviceEntry,
  templateMirrorSources,
} from './mirror-resolver.js'
import type { DeviceTemplateRenderer } from './template-renderer.js'

/** What the host needs to know about a device a template names. */
export interface TemplateDeviceRow {
  readonly deviceId: number
  readonly addonId: string
  readonly stableId: string
  readonly alias: string
}

export interface DeviceTemplateHostDeps {
  readonly renderer: Pick<DeviceTemplateRenderer, 'render' | 'validate'>
  /** The device that owns an alias, from the persisted rows. */
  findByAlias(alias: string): Promise<TemplateDeviceRow | null>
  /** The device row behind an id, for the device a render is FOR (`camera`). */
  findById(deviceId: number): Promise<TemplateDeviceRow | null>
  /** The capabilities a device is bound to (its template namespace). */
  capsOf(deviceId: number): Promise<readonly string[]>
  /** One runtime-state slice, as the effective merge every consumer sees. */
  fetchSlice(deviceId: number, cap: string): Promise<unknown>
  /** The D944 base unit of a numeric field, when the cap declares one. */
  readonly unitOf?: DeviceTemplateView['unitOf']
  readonly logger: IScopedLogger
}

/** One alias a template names, and whether the caller may read it. */
export interface TemplateAliasUse {
  readonly alias: string
  readonly deviceId: number | null
  readonly allowed: boolean
  /** The persisted row, resolved once here and reused by the render. */
  readonly row: TemplateDeviceRow | null
  /** The fields the text reads on this alias, as written (`temperature`, `cap.field`). */
  readonly reads: readonly string[]
}

export type TemplateCheck =
  | {
      readonly ok: true
      readonly aliases: readonly TemplateAliasUse[]
      /** The text reads `now`: its output moves with the clock. */
      readonly readsClock: boolean
    }
  | {
      readonly ok: false
      readonly reason: DeviceTemplateRefusalReason
      readonly message: string
    }

export class DeviceTemplateHost {
  constructor(private readonly deps: DeviceTemplateHostDeps) {}

  /**
   * Which devices a template names, without rendering it. `allowed` is the set
   * of device ids the caller was proven to see; `undefined` means no
   * restriction (an admin, a system run). A restricted caller gets the same
   * answer for an alias that does not exist and one it may not see.
   */
  async check(
    source: string,
    allowed: ReadonlySet<number> | undefined,
    thisDevice?: DeviceTemplateThisDevice,
  ): Promise<TemplateCheck> {
    const analysis = this.deps.renderer.validate(source)
    if (!analysis.ok) {
      return { ok: false, reason: analysis.refusal.reason, message: analysis.refusal.message }
    }
    const aliases: TemplateAliasUse[] = []
    const named = analysis.refs.filter((ref) => ref.alias !== DEVICE_TEMPLATE_NOW_ALIAS)
    for (const alias of new Set(named.map((ref) => ref.alias))) {
      const row = await this.rowOf(alias, thisDevice)
      aliases.push({
        alias,
        deviceId: row === null ? null : row.deviceId,
        allowed: allowed === undefined || (row !== null && allowed.has(row.deviceId)),
        row,
        reads: [
          ...new Set(
            named.filter((ref) => ref.alias === alias).map((ref) => ref.path.map(String).join('.')),
          ),
        ].filter((read) => read !== ''),
      })
    }
    return {
      ok: true,
      aliases,
      readsClock: analysis.refs.some((ref) => ref.alias === DEVICE_TEMPLATE_NOW_ALIAS),
    }
  }

  /** `camera` is the device the render is for when the call names one; every other alias is a device's own. */
  private async rowOf(
    alias: string,
    thisDevice: DeviceTemplateThisDevice | undefined,
  ): Promise<TemplateDeviceRow | null> {
    if (alias === DEVICE_TEMPLATE_THIS_ALIAS && thisDevice !== undefined) {
      const row = await this.deps.findById(thisDevice.deviceId)
      return row === null ? null : { ...row, alias }
    }
    return this.deps.findByAlias(alias)
  }

  /** Render every template; answers are index-aligned with the questions. */
  async render(
    sources: readonly string[],
    allowed: ReadonlySet<number> | undefined,
    thisDevice?: DeviceTemplateThisDevice,
  ): Promise<DeviceTemplateRender[]> {
    const checks = await Promise.all(
      sources.map((source) => this.check(source, allowed, thisDevice)),
    )
    const rows = new Map<string, TemplateDeviceEntry>()
    for (const check of checks) {
      if (!check.ok) continue
      for (const use of check.aliases) {
        if (!use.allowed || use.row === null || rows.has(use.alias)) continue
        const caps = await this.deps.capsOf(use.row.deviceId)
        rows.set(use.alias, {
          ...use.row,
          caps,
          ...(use.alias === DEVICE_TEMPLATE_THIS_ALIAS && thisDevice?.values !== undefined
            ? { values: { [DEVICE_TEMPLATE_VALUES_CAP]: thisDevice.values } }
            : {}),
        })
      }
    }
    const entries = [...rows.values()]
    const mirror = new ConditionMirror(templateMirrorSources(entries))
    const report = await mirror.refresh({
      fetchSlice: (deviceId, cap) => this.deps.fetchSlice(deviceId, cap),
      fetchStableIds: async () => new Map(),
    })
    if (report.kept > 0) {
      this.deps.logger.debug('template mirror kept no value for some slices', {
        meta: { ...report },
      })
    }
    const resolver = mirrorTemplateResolver(mirror, entries, this.deps.unitOf)
    const out: DeviceTemplateRender[] = []
    let warned = false
    for (const [index, source] of sources.entries()) {
      const check = checks[index]
      if (check === undefined || !check.ok) {
        out.push({
          ok: false,
          refusal: {
            reason: check === undefined ? 'render-failed' : check.reason,
            message: check === undefined ? 'no check' : check.message,
          },
          trace: [],
        })
        continue
      }
      const refused = check.aliases.find((use) => !use.allowed)
      if (refused !== undefined) {
        if (!warned) {
          warned = true
          this.deps.logger.warn(
            'device template refused — it names a device the caller was not proven to see',
            {
              ...(refused.deviceId === null ? {} : { tags: { deviceId: refused.deviceId } }),
              meta: { alias: refused.alias },
            },
          )
        }
        out.push({
          ok: false,
          refusal: {
            reason: 'out-of-scope',
            message: `the template names "${refused.alias}", a device this caller cannot see`,
          },
          trace: [],
        })
        continue
      }
      const rendered = await this.deps.renderer.render(source, resolver)
      out.push(
        rendered.ok
          ? { ok: true, text: rendered.text, trace: [...rendered.trace] }
          : { ok: false, refusal: rendered.refusal, trace: [...rendered.trace] },
      )
    }
    return out
  }
}
