/**
 * Installed inventory — pure derivation for Model Studio → Installed.
 *
 * One row per FILE on the selected node: model × format (operator decision
 * 2026-10-07). A row's chips are the node's devices of that format; NPU and
 * iGPU sharing one OpenVINO IR are two chips on one row. Each chip answers two
 * separate questions:
 *
 *  - `loaded` — the model is RESIDENT in that device's pool right now
 *    (`pipelineExecutor.listLoadedEngines`). `null` when that read failed.
 *  - `configured` — the device is enabled, the file is current on disk, and
 *    the device's effective model for the step is this one
 *    (`acceleratorsRunningModel`, or the cluster row for a cluster-scoped step).
 *
 * The row's {@link InstalledUsage} follows from them; only `idle` and `unused`
 * files can be removed. No React, no tRPC — `installed-inventory.test.ts`.
 */
import { acceleratorShortLabel } from '@camstack/ui-library'
import type {
  ClusterStepModels,
  CustomModelDescriptor,
  ModelFormatPrecision,
  ModelOnDiskState,
  ModelProviderId,
  NodeInferenceDevice,
  RootStepSupply,
} from '@camstack/types'
import { inferModelProvider, isClusterScopedStep } from '@camstack/types'
import { resolveModelDisplayName } from '../display-name.js'
import { acceleratorsRunningModel } from './installed-activation.js'
import {
  rowSupplies,
  suppliesField,
  type AvailabilityMap,
  type CatalogSeed,
  type CatalogSeedFormat,
  type StepCatalogSlice,
} from './model-studio-ui.js'

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** `NPU` / `iGPU` / `CPU` / `Coral` / `ANE` — the shared short name (`acceleratorShortLabel`). */
export function deviceShortLabel(
  d: Pick<NodeInferenceDevice, 'backend' | 'device' | 'key'>,
): string {
  return acceleratorShortLabel(d)
}

export interface DeviceFilterOption {
  readonly value: string
  readonly label: string
  /** A disabled device is listed (it may still hold files) and rendered "off". */
  readonly enabled: boolean
}

/** One option per device of the node, in the node's order. */
export function deviceFilterOptions(
  devices: readonly NodeInferenceDevice[],
): readonly DeviceFilterOption[] {
  return devices.map((d) => ({ value: d.key, label: deviceShortLabel(d), enabled: d.enabled }))
}

// ---------------------------------------------------------------------------
// Resident pools
// ---------------------------------------------------------------------------

/** The fields of a `listLoadedEngines` row this page reads. */
export interface ResidentEngineView {
  readonly engineKey: string
  readonly engine: { readonly backend: string; readonly format: string; readonly device?: string }
  readonly kind: 'runtime' | 'device-pool'
  readonly modelsLoaded: readonly string[]
}

const POOL_KEY_SUFFIX = /\[([^\]]+)\]\s*$/

/**
 * Whether `engine` is `device`'s pool. A device pool names its key in its
 * engine key (`python/openvino/gpu [openvino:gpu]`); the node's runtime pool
 * does not, and is matched on backend + device (`python/openvino/npu`).
 */
export function engineServesDevice(
  engine: ResidentEngineView,
  device: Pick<NodeInferenceDevice, 'key' | 'backend' | 'device' | 'format'>,
): boolean {
  const named = POOL_KEY_SUFFIX.exec(engine.engineKey)?.[1]
  if (named !== undefined) return named === device.key
  if (engine.engine.format !== device.format) return false
  if (engine.engine.backend === device.backend) return engine.engine.device === device.device
  return device.key === 'cpu' && engine.engine.device === 'cpu'
}

/** Resident in `device`'s pool? `null` when the engine read failed. */
export function loadedOnDevice(
  engines: readonly ResidentEngineView[] | null,
  device: NodeInferenceDevice,
  stepId: string,
  modelId: string,
): boolean | null {
  if (engines === null) return null
  const ref = `${stepId}/${modelId}`
  return engines.some((e) => engineServesDevice(e, device) && e.modelsLoaded.includes(ref))
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * - `in-use` — resident in at least one device's pool.
 * - `configured` — a device is configured for it but has not loaded it.
 * - `idle` — an enabled device could run this format; none is using it.
 * - `unused` — no enabled device runs this format: reclaimable space.
 * - `outside-pools` — served by its own process (the audio analyzer).
 * - `unknown` — the loaded-engine read failed; idle cannot be told apart.
 */
export type InstalledUsage =
  | 'in-use'
  | 'configured'
  | 'idle'
  | 'unused'
  | 'outside-pools'
  | 'unknown'

export interface InstalledDeviceChip {
  readonly deviceKey: string
  readonly label: string
  readonly enabled: boolean
  readonly loaded: boolean | null
  readonly configured: boolean
}

export interface InstalledFileRow {
  /** `stepId::modelId::format` — unique per node. */
  readonly key: string
  readonly stepId: string
  readonly modelId: string
  readonly name: string
  readonly description: string
  readonly provider: ModelProviderId
  readonly format: string
  readonly sizeMB: number
  readonly precision?: ModelFormatPrecision
  /** Never `missing`: a row is a file on disk. */
  readonly onDisk: Exclude<ModelOnDiskState, 'missing'>
  /** `registry` = an imported model (renameable; removal goes through the registry). */
  readonly origin: 'pipeline' | 'registry'
  readonly renameable: boolean
  readonly clusterScoped: boolean
  readonly chips: readonly InstalledDeviceChip[]
  readonly usage: InstalledUsage
  readonly removable: boolean
  readonly supplies?: readonly RootStepSupply[]
}

/**
 * Slots whose models no inference-device pool runs. The audio classifier is
 * run by the audio analyzer's own process (`audio-pipeline.ts`, `ensureModel`
 * → `yamnet_audio.py`), so "no enabled device of this format" says nothing
 * about whether it is used.
 */
const SLOTS_OUTSIDE_DEVICE_POOLS: ReadonlySet<string> = new Set(['audio-classifier'])

export interface InstalledInventoryInput {
  readonly nodeId: string
  readonly seeds: readonly CatalogSeed[]
  readonly stepCatalogs: Readonly<Record<string, StepCatalogSlice>>
  readonly devices: readonly NodeInferenceDevice[]
  readonly engines: readonly ResidentEngineView[] | null
  readonly clusterModels: ClusterStepModels | null
  readonly registry: readonly CustomModelDescriptor[]
  readonly availability: AvailabilityMap
}

interface RowFacts {
  readonly stepId: string
  readonly modelId: string
  readonly name: string
  readonly description: string
  readonly provider: ModelProviderId
  readonly format: string
  readonly sizeMB: number
  readonly precision?: ModelFormatPrecision
  readonly onDisk: Exclude<ModelOnDiskState, 'missing'>
  readonly origin: 'pipeline' | 'registry'
  readonly supplies?: readonly RootStepSupply[]
}

/** The cluster row's model for a cluster-scoped step (default when unset). */
function clusterModelFor(
  stepId: string,
  clusterModels: ClusterStepModels | null,
  catalog: StepCatalogSlice | undefined,
): string | undefined {
  return clusterModels?.[stepId] ?? catalog?.defaultModelId
}

/** Device keys configured for this file (see the module doc). */
function configuredKeys(facts: RowFacts, input: InstalledInventoryInput): ReadonlySet<string> {
  if (facts.onDisk !== 'current') return new Set()
  const catalog = input.stepCatalogs[facts.stepId]
  const current = new Set([facts.format])
  if (isClusterScopedStep(facts.stepId)) {
    if (clusterModelFor(facts.stepId, input.clusterModels, catalog) !== facts.modelId) {
      return new Set()
    }
    return new Set(
      input.devices.filter((d) => d.enabled && d.format === facts.format).map((d) => d.key),
    )
  }
  return new Set(
    acceleratorsRunningModel(input.devices, facts.stepId, facts.modelId, catalog, current).map(
      (a) => a.deviceKey,
    ),
  )
}

function usageOf(
  chips: readonly InstalledDeviceChip[],
  outsidePools: boolean,
  enginesKnown: boolean,
): InstalledUsage {
  if (outsidePools) return 'outside-pools'
  if (chips.some((c) => c.loaded === true)) return 'in-use'
  if (chips.some((c) => c.configured)) return 'configured'
  if (!chips.some((c) => c.enabled)) return 'unused'
  return enginesKnown ? 'idle' : 'unknown'
}

function toRow(facts: RowFacts, input: InstalledInventoryInput): InstalledFileRow {
  const configured = configuredKeys(facts, input)
  const chips = input.devices
    .filter((d) => d.format === facts.format)
    .map(
      (d): InstalledDeviceChip => ({
        deviceKey: d.key,
        label: deviceShortLabel(d),
        enabled: d.enabled,
        loaded: loadedOnDevice(input.engines, d, facts.stepId, facts.modelId),
        configured: configured.has(d.key),
      }),
    )
    .toSorted((a, b) => a.label.localeCompare(b.label))
  const slot = input.stepCatalogs[facts.stepId]?.slot
  const usage = usageOf(
    chips,
    slot !== undefined && SLOTS_OUTSIDE_DEVICE_POOLS.has(slot),
    input.engines !== null,
  )
  return {
    ...facts,
    key: `${facts.stepId}::${facts.modelId}::${facts.format}`,
    renameable: facts.origin === 'registry',
    clusterScoped: isClusterScopedStep(facts.stepId),
    chips,
    usage,
    removable: usage === 'idle' || usage === 'unused',
  }
}

function seedFacts(
  seed: CatalogSeed,
  f: CatalogSeedFormat,
  registryIds: ReadonlySet<string>,
): RowFacts | null {
  if (f.onDisk === 'missing') return null
  return {
    stepId: seed.stepId,
    modelId: seed.modelId,
    name: seed.name,
    description: '',
    provider: seed.provider,
    format: f.format,
    sizeMB: f.sizeMB,
    ...(f.precision !== undefined ? { precision: f.precision } : {}),
    onDisk: f.onDisk,
    origin: registryIds.has(seed.modelId) ? 'registry' : 'pipeline',
    ...suppliesField(seed.supplies),
  }
}

/** Registry formats recorded on this node that the node's schema did not list. */
function registryFacts(
  input: InstalledInventoryInput,
  listed: ReadonlySet<string>,
): readonly RowFacts[] {
  const out: RowFacts[] = []
  for (const descriptor of input.registry) {
    const id = descriptor.entry.id
    const onNode = input.availability[id]?.[input.nodeId]
    if (onNode === undefined) continue
    for (const [format, presence] of Object.entries(onNode.formats)) {
      if (listed.has(`${descriptor.stepId}::${id}::${format}`)) continue
      out.push({
        stepId: descriptor.stepId,
        modelId: id,
        name: resolveModelDisplayName(descriptor.entry),
        description: descriptor.entry.description,
        provider: inferModelProvider({
          id,
          description: descriptor.entry.description,
          provider: descriptor.entry.provider,
        }),
        format,
        sizeMB: presence.bytes / 1_000_000,
        onDisk: 'current',
        origin: 'registry',
        ...suppliesField(rowSupplies(descriptor)),
      })
    }
  }
  return out
}

export function buildInstalledInventory(
  input: InstalledInventoryInput,
): readonly InstalledFileRow[] {
  const registryIds = new Set(input.registry.map((m) => m.entry.id))
  const fromSeeds = input.seeds.flatMap((seed) =>
    seed.formats.flatMap((f) => {
      const facts = seedFacts(seed, f, registryIds)
      return facts === null ? [] : [facts]
    }),
  )
  const listed = new Set(fromSeeds.map((f) => `${f.stepId}::${f.modelId}::${f.format}`))
  const descriptions = new Map(input.registry.map((m) => [m.entry.id, m.entry.description]))
  return [...fromSeeds, ...registryFacts(input, listed)]
    .map((facts) => ({
      ...facts,
      description: descriptions.get(facts.modelId) ?? facts.description,
    }))
    .map((facts) => toRow(facts, input))
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.format.localeCompare(b.format))
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface InventoryFilters {
  readonly provider: 'all' | ModelProviderId
  readonly step: string
  /** `all`, or a device key: rows whose format that device runs. */
  readonly device: string
}

export function filterInventoryRows(
  rows: readonly InstalledFileRow[],
  devices: readonly NodeInferenceDevice[],
  filters: InventoryFilters,
): readonly InstalledFileRow[] {
  const deviceFormat =
    filters.device === 'all' ? undefined : devices.find((d) => d.key === filters.device)?.format
  return rows.filter((r) => {
    if (filters.provider !== 'all' && r.provider !== filters.provider) return false
    if (filters.step !== 'all' && r.stepId !== filters.step) return false
    if (filters.device !== 'all' && r.format !== deviceFormat) return false
    return true
  })
}

/** Reclaimable total: what Remove can free on this node (idle + unused files). */
export function reclaimableMB(rows: readonly InstalledFileRow[]): number {
  return rows.filter((r) => r.removable).reduce((sum, r) => sum + r.sizeMB, 0)
}

// ---------------------------------------------------------------------------
// Cluster models — where the ONE cluster model runs, per node
// ---------------------------------------------------------------------------

export type ClusterNodeInput =
  | {
      readonly nodeId: string
      readonly seeds: readonly CatalogSeed[]
      readonly stepCatalogs: Readonly<Record<string, StepCatalogSlice>>
      readonly devices: readonly NodeInferenceDevice[]
      readonly engines: readonly ResidentEngineView[] | null
      readonly error?: undefined
    }
  | { readonly nodeId: string; readonly error: string }

export interface ClusterPlacementEntry {
  readonly format: string
  readonly devices: readonly {
    readonly deviceKey: string
    readonly label: string
    readonly loaded: boolean | null
  }[]
  /** `refused` — the model has no build for this format: the node refuses the step. */
  readonly state: 'loaded' | 'not-loaded' | 'refused' | 'unknown'
  readonly onDisk: ModelOnDiskState
}

export interface ClusterNodePlacement {
  readonly nodeId: string
  readonly entries: readonly ClusterPlacementEntry[]
  readonly error?: string
}

export interface ClusterModelPlacement {
  readonly stepId: string
  readonly modelId: string
  readonly nodes: readonly ClusterNodePlacement[]
}

function placementEntry(
  node: Extract<ClusterNodeInput, { error?: undefined }>,
  stepId: string,
  modelId: string,
  format: string,
): ClusterPlacementEntry {
  const devices = node.devices
    .filter((d) => d.enabled && d.format === format)
    .map((d) => ({
      deviceKey: d.key,
      label: deviceShortLabel(d),
      loaded: loadedOnDevice(node.engines, d, stepId, modelId),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label))
  const model = node.stepCatalogs[stepId]?.models.find((m) => m.id === modelId)
  const seed = node.seeds.find((s) => s.stepId === stepId && s.modelId === modelId)
  const onDisk = seed?.formats.find((f) => f.format === format)?.onDisk ?? 'missing'
  const build = model?.formats[format] !== undefined
  const state = !build
    ? 'refused'
    : devices.some((d) => d.loaded === true)
      ? 'loaded'
      : devices.some((d) => d.loaded === null)
        ? 'unknown'
        : 'not-loaded'
  return { format, devices, state, onDisk }
}

/** One entry per (node, format of its enabled devices). */
export function buildClusterPlacement(
  stepId: string,
  modelId: string,
  nodes: readonly ClusterNodeInput[],
): ClusterModelPlacement {
  return {
    stepId,
    modelId,
    nodes: nodes.map((node): ClusterNodePlacement => {
      if (node.error !== undefined) return { nodeId: node.nodeId, entries: [], error: node.error }
      const formats = [...new Set(node.devices.filter((d) => d.enabled).map((d) => d.format))]
      return {
        nodeId: node.nodeId,
        entries: formats.map((format) => placementEntry(node, stepId, modelId, format)),
      }
    }),
  }
}
