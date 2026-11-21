/**
 * Whole-capability links at runtime (D1076): the read behind `getCapLinks` and
 * the one-off conversion behind `migrateCapLinks`.
 *
 * The compile path is not here: a `capLink` is expanded by `planComposition`
 * into the field claims the composer already runs. This file only READS the
 * stored links (state per link, `not-loaded` until the compositions were read,
 * D315) and REWRITES plain per-field links into one link (bounded, idempotent,
 * D345).
 */
import {
  type CapLinkView,
  type CapLinksRead,
  type Composition,
  type CompositionCapLinkFeature,
  type CompositionFeature,
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  type CoreBlock,
  type IScopedLogger,
  type MigratedCapLink,
  type MigrateCapLinksReport,
  type MixedCapLink,
  compositionFeatureEnabled,
  capLinkServedFields,
  compositionSourceKey,
  coreBlockComposition,
  declaredCapLink,
  errMsg,
  projectCapLinkOf,
} from '@camstack/types'

export interface CapLinksPorts {
  /** The stored blocks, or null until the table has been READ. */
  readonly blocks: () => readonly CoreBlock[] | null
  /** The stable identity of a device; null when the row is gone. */
  readonly refOfDevice: (deviceId: number) => Promise<CompositionSourceRef | null>
  /** The numeric id of a device identity; null when no row carries it. */
  readonly deviceIdOf: (ref: CompositionSourceRef) => Promise<number | null>
  /** One composition write, judged by the composition API. */
  /** The top-level state fields of a cap (what a project link serves); null for an unknown cap. */
  readonly hostFieldsOf: (cap: string) => readonly string[] | null
  readonly rewrite: (block: CoreBlock, composition: Composition) => Promise<CoreBlock>
  readonly logger: IScopedLogger
}

function hostBlock(blocks: readonly CoreBlock[], host: CompositionSourceRef): CoreBlock | null {
  const key = compositionSourceKey(host)
  return (
    blocks.find((block) => {
      const target = coreBlockComposition(block)?.target
      return target?.kind === 'existing' && compositionSourceKey(target.device) === key
    }) ?? null
  )
}

function capLinkFeatures(composition: Composition | null): readonly CompositionCapLinkFeature[] {
  return (composition?.features ?? []).flatMap((feature) =>
    feature.kind === 'capLink' ? [feature] : [],
  )
}

export class CapLinksService {
  /** `host:cap:link` keys whose source-gone was already logged: one line per loss, not per read. */
  private readonly goneLogged = new Set<string>()

  constructor(private readonly ports: CapLinksPorts) {}

  async read(deviceId: number): Promise<CapLinksRead> {
    const blocks = this.ports.blocks()
    if (blocks === null) return { status: 'not-loaded' }
    const host = await this.ports.refOfDevice(deviceId)
    if (host === null) return { status: 'ok', links: [] }
    const block = hostBlock(blocks, host)
    const features = capLinkFeatures(block === null ? null : coreBlockComposition(block))
    const links: CapLinkView[] = []
    for (const feature of features) {
      const declared = declaredCapLink(feature.cap, feature.linkId)
      if (declared === undefined) continue
      const sourceId = await this.ports.deviceIdOf(feature.source)
      const gone = sourceId === null
      const state = !compositionFeatureEnabled(feature)
        ? 'disabled'
        : gone
          ? 'source-gone'
          : 'linked'
      if (state === 'source-gone') this.logGone(deviceId, feature)
      else this.goneLogged.delete(goneKey(deviceId, feature))
      links.push({
        linkId: feature.linkId,
        cap: feature.cap,
        slot: declared.slot ?? null,
        mode: declared.mode,
        source: { deviceId: sourceId, cap: declared.sourceCap },
        state,
      })
    }
    return { status: 'ok', links }
  }

  private logGone(deviceId: number, feature: CompositionCapLinkFeature): void {
    const key = goneKey(deviceId, feature)
    if (this.goneLogged.has(key)) return
    this.goneLogged.add(key)
    this.ports.logger.warn('cap link: the source device is gone — the linked cap reads unknown', {
      tags: { deviceId },
      meta: { cap: feature.cap, linkId: feature.linkId, source: feature.source },
    })
  }

  async migrate(dryRun: boolean): Promise<MigrateCapLinksReport> {
    const blocks = this.ports.blocks()
    if (blocks === null) {
      throw new Error('core-blocks: the compositions have not loaded yet — migrateCapLinks refused')
    }
    const report = {
      dryRun,
      converted: [] as MigratedCapLink[],
      mixed: [] as MixedCapLink[],
      skipped: 0,
      alreadyLinked: 0,
    }
    for (const block of blocks) {
      const composition = coreBlockComposition(block)
      if (composition === null || composition.target.kind !== 'existing') continue
      const deviceId = await this.ports.deviceIdOf(composition.target.device)
      if (deviceId === null) {
        this.ports.logger.warn(
          'cap link migration: host device not found — customization left as is',
          {
            meta: { blockId: block.id },
          },
        )
        continue
      }
      await this.migrateBlock(block, composition, deviceId, dryRun, report)
    }
    return report
  }

  private async migrateBlock(
    stored: CoreBlock,
    composition: Composition,
    deviceId: number,
    dryRun: boolean,
    report: {
      converted: MigratedCapLink[]
      mixed: MixedCapLink[]
      skipped: number
      alreadyLinked: number
    },
  ): Promise<void> {
    const caps = [
      ...new Set(
        composition.features.flatMap((f) =>
          f.kind === 'fields' || f.kind === 'capLink' ? [f.cap] : [],
        ),
      ),
    ]
    let block = stored
    let next = composition
    for (const cap of caps) {
      const link = projectCapLinkOf(cap)
      if (link === undefined) continue
      if (capLinkFeatures(next).some((f) => f.cap === cap)) {
        report.alreadyLinked += 1
        continue
      }
      const plain = next.features.filter(
        (f): f is CompositionFieldsFeature => f.kind === 'fields' && f.cap === cap,
      )
      const candidates = plain.filter(
        (f) => f.contributedBy === undefined && compositionFeatureEnabled(f),
      )
      report.skipped += plain.length - candidates.length
      if (candidates.length === 0) continue
      const verdict = identityGroup(candidates, link.sourceCap, link.map)
      const hostFields = this.ports.hostFieldsOf(cap)
      const reasons =
        'reasons' in verdict
          ? verdict.reasons
          : hostFields === null
            ? [`the capability ${cap} is unknown here`]
            : widening(capLinkServedFields(link, hostFields), verdict.fields, next, candidates)
      if ('reasons' in verdict || reasons.length > 0) {
        report.mixed.push({ deviceId, cap, reasons })
        continue
      }
      if ('reasons' in verdict) continue
      const feature: CompositionCapLinkFeature = {
        kind: 'capLink',
        cap,
        linkId: link.id,
        source: verdict.source,
      }
      const replaced = new Set<CompositionFeature>(candidates)
      const kept = next.features.filter((f) => !replaced.has(f))
      const candidate: Composition = { ...next, features: kept.concat(feature) }
      const converted: MigratedCapLink = {
        deviceId,
        cap,
        linkId: link.id,
        source: verdict.source,
        fields: verdict.fields,
      }
      if (!dryRun) {
        try {
          block = await this.ports.rewrite(block, candidate)
        } catch (err: unknown) {
          report.mixed.push({ deviceId, cap, reasons: [`the link was refused: ${errMsg(err)}`] })
          this.ports.logger.warn('cap link migration: conversion refused — left as it was', {
            tags: { deviceId },
            meta: { cap, error: errMsg(err) },
          })
          continue
        }
      }
      next = candidate
      report.converted.push(converted)
    }
  }
}

/**
 * Why converting would change what the device claims. The link serves EVERY host
 * field of the cap (and the clock as `now`): a set that covers fewer would newly
 * take the rest from the source, and an enabled feature another writer left on
 * the cap would overlap the link. The operator decides per device.
 */
function widening(
  served: readonly string[],
  carried: readonly string[],
  next: Composition,
  candidates: readonly CompositionFieldsFeature[],
): string[] {
  const reasons: string[] = []
  const missing = served.filter((path) => !carried.includes(path))
  if (missing.length > 0) reasons.push(`partial-set: would also take ${missing.join(', ')}`)
  const taken = new Set<CompositionFeature>(candidates)
  for (const other of next.features) {
    if (other.kind !== 'fields' || taken.has(other) || !compositionFeatureEnabled(other)) continue
    const clash = Object.keys(other.fields).filter((path) => served.includes(path))
    if (clash.length > 0) {
      const by =
        other.contributedBy === undefined
          ? 'another feature'
          : `the device link ${other.contributedBy.linkId}`
      reasons.push(`overlap: ${by} also writes ${clash.join(', ')}, which the link would serve`)
    }
  }
  return reasons
}

function goneKey(deviceId: number, feature: CompositionCapLinkFeature): string {
  return `${deviceId}:${feature.cap}:${feature.linkId}`
}

type Group =
  | { readonly source: CompositionSourceRef; readonly fields: string[] }
  | { readonly reasons: string[] }

/**
 * The features are ONE link when every field is a plain read of the SAME source
 * device's `sourceCap`, at the path the link maps it to (the same path without a
 * map), plus the `now` clock. Anything else is named, per field.
 */
function identityGroup(
  features: readonly CompositionFieldsFeature[],
  sourceCap: string,
  map: Readonly<Record<string, string>> | undefined,
): Group {
  const reasons: string[] = []
  const sources = new Map<string, CompositionSourceRef>()
  const fields: string[] = []
  for (const feature of features) {
    for (const [path, value] of Object.entries(feature.fields)) {
      fields.push(path)
      if (value.kind === 'expression' && value.expr === 'now' && path === 'lastFetchedAt') continue
      if (path === 'lastFetchedAt') {
        reasons.push('lastFetchedAt: reads the source clock, the link writes now')
        continue
      }
      if (value.kind !== 'from') {
        reasons.push(`${path}: a ${value.kind} source`)
        continue
      }
      if (value.cap !== sourceCap) reasons.push(`${path}: reads ${value.cap}, not ${sourceCap}`)
      else if (value.fieldPath !== (map?.[path] ?? path)) {
        reasons.push(`${path}: reads ${value.fieldPath}, not the same path`)
      }
      sources.set(compositionSourceKey(value.source), value.source)
    }
    for (const extra of ['items', 'commands'] as const) {
      if (feature[extra] !== undefined) reasons.push(`the feature carries ${extra}`)
    }
  }
  const [first] = [...sources.values()]
  if (sources.size > 1) reasons.push(`${sources.size} different source devices`)
  if (first === undefined && reasons.length === 0) reasons.push('no source device')
  return reasons.length > 0 || first === undefined ? { reasons } : { source: first, fields }
}
