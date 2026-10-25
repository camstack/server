/**
 * The plus catalog account catalog as Catalog-style family cards.
 *
 * The caller narrows by kind (base / custom) and release; everything that
 * survives becomes cards, ALL visible at once — there is no runtime filter:
 *   - family     = architecture (`yolov9`, `yolonas`, `mobiledet`, …)
 *   - tier       = weight letter (`t`/`s`/…) or `default` when weightless
 *   - resolution = input width
 *
 * One chip (family × tier × resolution) gathers every plus catalog BUILD of that
 * combination: the neural build (ONNX, from which OpenVINO and CoreML are
 * converted) and the EdgeTPU build (TFLite) are separate plus catalog model ids,
 * and they become formats of the same chip. A format is offered only when a
 * build behind it exists and this cluster has an engine that can run it
 * ({@link plusImportLane}) — Hailo / RKNN / ROCm / CPU-tflite builds never
 * reach a card.
 */
import type { ModelVariantSource } from '@camstack/types'
import {
  dimensionsOf,
  parseModelName,
  plusImportLane,
  type PlusModelSummary,
} from './plus-catalog-api.js'

const WEIGHT_LABELS: Readonly<Record<string, string>> = {
  n: 'Nano',
  t: 'Tiny',
  s: 'Small',
  m: 'Medium',
  c: 'Compact',
  l: 'Large',
  x: 'Extra large',
}

/** A format an operator can import for a chip. */
export type PlusImportFormat = 'onnx' | 'openvino' | 'coreml' | 'tflite'

/** Display / button order inside a card. */
const FORMAT_ORDER: readonly PlusImportFormat[] = ['onnx', 'openvino', 'coreml', 'tflite']

export interface PlusFormatOffer {
  readonly format: PlusImportFormat
  /** The plus catalog build this format comes from (download source). */
  readonly plusModelId: string
  /** `download` = the native artifact; `convert` = made from that build's ONNX. */
  readonly via: 'download' | 'convert'
  /** A TFLite build loads only where a Coral is (the pool's tflite runtime is EdgeTPU). */
  readonly needsCoral: boolean
}

/** Every build of one combination that came out of the same plus catalog training run. */
export interface PlusTraining {
  /** Training day (`YYYY-MM-DD`) — the neural and EdgeTPU builds of one run share it. */
  readonly key: string
  readonly trainDate: string
  readonly verifiedImages: number
  readonly builds: readonly PlusModelSummary[]
  readonly offers: readonly PlusFormatOffer[]
}

export interface PlusCatalogCombo {
  readonly sourceId: string
  readonly family: string
  readonly tier: string
  readonly resolution?: number
  readonly name: string
  /** Newest first; the first is the default selection. */
  readonly trainings: readonly PlusTraining[]
}

export interface PlusCatalogView {
  readonly sources: readonly ModelVariantSource[]
  readonly combos: ReadonlyMap<string, PlusCatalogCombo>
}

/** Only the builds CamStack has an engine for. */
export function runnablePlusModels(
  models: readonly PlusModelSummary[],
): readonly PlusModelSummary[] {
  return models.filter((m) => plusImportLane(m) !== null)
}

function resolutionOf(m: PlusModelSummary): number | undefined {
  if (m.width !== undefined && m.height !== undefined) {
    return m.width === m.height ? m.width : Math.max(m.width, m.height)
  }
  const match = /^(\d+)x(\d+)$/.exec(dimensionsOf(m))
  if (!match) return undefined
  const w = Number(match[1])
  const h = Number(match[2])
  if (!Number.isFinite(w) || !Number.isFinite(h)) return undefined
  return w === h ? w : Math.max(w, h)
}

function displayName(architecture: string, weight: string): string {
  if (weight.length === 0) {
    if (architecture === 'mobiledet') return 'SSDLite MobileDet'
    if (architecture === 'yolonas') return 'YOLO-NAS'
    return architecture.toUpperCase()
  }
  const size = WEIGHT_LABELS[weight] ?? weight.toUpperCase()
  if (architecture.startsWith('yolo')) {
    return `${architecture.replace(/^yolo/i, 'YOLO')} ${size}`
  }
  return `${architecture} ${size}`
}

const byDateDesc = (a: PlusModelSummary, b: PlusModelSummary) =>
  b.trainDate.localeCompare(a.trainDate)

/**
 * The formats one training run offers. The newest build per lane wins when a
 * run somehow carries two of the same lane.
 */
export function plusTrainingOffers(
  builds: readonly PlusModelSummary[],
): readonly PlusFormatOffer[] {
  const newest = [...builds].toSorted(byDateDesc)
  const neural = newest.find((m) => plusImportLane(m) === 'neural')
  const coral = newest.find((m) => plusImportLane(m) === 'coral')
  const offers: PlusFormatOffer[] = []
  if (neural !== undefined) {
    offers.push({
      format: 'onnx',
      plusModelId: neural.id,
      via: 'download',
      needsCoral: false,
    })
    offers.push({
      format: 'openvino',
      plusModelId: neural.id,
      via: 'convert',
      needsCoral: false,
    })
    offers.push({
      format: 'coreml',
      plusModelId: neural.id,
      via: 'convert',
      needsCoral: false,
    })
  }
  if (coral !== undefined) {
    offers.push({
      format: 'tflite',
      plusModelId: coral.id,
      via: 'download',
      needsCoral: true,
    })
  }
  return offers.toSorted((a, b) => FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format))
}

function trainingsOf(builds: readonly PlusModelSummary[]): readonly PlusTraining[] {
  const byDay = new Map<string, PlusModelSummary[]>()
  for (const m of builds) {
    const key = m.trainDate.slice(0, 10)
    byDay.set(key, [...(byDay.get(key) ?? []), m])
  }
  return [...byDay.entries()]
    .map(([key, rows]): PlusTraining => {
      const sorted = rows.toSorted(byDateDesc)
      return {
        key,
        trainDate: sorted[0]?.trainDate ?? '',
        verifiedImages: Math.max(0, ...sorted.map((m) => m.verifiedImages)),
        builds: sorted,
        offers: plusTrainingOffers(sorted),
      }
    })
    .filter((t) => t.offers.length > 0)
    .toSorted((a, b) => b.trainDate.localeCompare(a.trainDate))
}

/**
 * Cards for an already kind/release-narrowed list. Unrunnable builds are
 * dropped first, so a combination that only Hailo or a CPU-tflite build
 * offers yields no chip at all.
 */
export function buildPlusCatalog(models: readonly PlusModelSummary[]): PlusCatalogView {
  const buckets = new Map<
    string,
    {
      family: string
      tier: string
      resolution?: number
      name: string
      builds: PlusModelSummary[]
    }
  >()
  for (const m of runnablePlusModels(models)) {
    const parsed = parseModelName(m.name)
    const tier = parsed.weight.length > 0 ? parsed.weight : 'default'
    const resolution = resolutionOf(m)
    const sourceId = `${m.name}${resolution !== undefined ? `-${resolution}` : ''}`
    const bucket = buckets.get(sourceId) ?? {
      family: parsed.architecture,
      tier,
      ...(resolution !== undefined ? { resolution } : {}),
      name: displayName(parsed.architecture, parsed.weight),
      builds: [],
    }
    buckets.set(sourceId, { ...bucket, builds: [...bucket.builds, m] })
  }

  const combos = new Map<string, PlusCatalogCombo>()
  const sources: ModelVariantSource[] = []
  for (const [sourceId, bucket] of buckets) {
    const trainings = trainingsOf(bucket.builds)
    const newest = trainings[0]
    if (newest === undefined) continue
    combos.set(sourceId, {
      sourceId,
      family: bucket.family,
      tier: bucket.tier,
      ...(bucket.resolution !== undefined ? { resolution: bucket.resolution } : {}),
      name: bucket.name,
      trainings,
    })
    sources.push({
      id: sourceId,
      name: bucket.name,
      group: {
        family: bucket.family,
        tier: bucket.tier,
        ...(bucket.resolution !== undefined ? { resolution: bucket.resolution } : {}),
      },
      // plus catalog list/detail never carry artifact bytes.
      formats: Object.fromEntries(newest.offers.map((o) => [o.format, { sizeMB: 0 }])),
    })
  }
  return { sources, combos }
}
