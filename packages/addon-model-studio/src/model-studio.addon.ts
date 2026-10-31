import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deleteModelFromDisk, downloadFile } from '@camstack/system/addon-utils'
import { buildPluginCatalogRegistryDescriptor } from './plugin-catalog/plugin-catalog-import.js'
import type {
  AddonInitResult,
  AddonPageDeclaration,
  ConvertArtifact,
  CustomModelDescriptor,
  DurableState,
  IAddonPageProvider,
  ICustomModelRegistryProvider,
  ImportModelBundleInput,
  ImportModelBundleResult,
  ProviderRegistration,
} from '@camstack/types'
import {
  addonPagesSourceCapability,
  BaseAddon,
  nodePin,
  CustomModelDescriptorSchema,
  customModelRegistryCapability,
  nodeRemovalHookCapability,
  EventCategory,
  type ModelFormat,
  modelConvertCapability,
} from '@camstack/types'
import { z } from 'zod'
import { convertModel, type NodeHardware, recommendConvertNode } from './convert-orchestrator.js'
import {
  buildModelConvertProvider,
  type ConvertProgress,
  ConvertProgressSchema,
  ConvertResultLineSchema,
  type ModelConvertProviderDeps,
} from './model-convert-provider.js'
import {
  clearAvailability,
  clearAvailabilityFormat,
  pruneOrphanAvailability,
  removeCustomModel,
  renameCustomModel,
  stripModelIdFromInferenceDevices,
  upsertAvailability,
  upsertCustomModel,
  type ImportedNames,
  type RenameResult,
  type UpsertNameOrigin,
} from './model-registry.js'
import { createNodeRemovalHook } from './node-removal.js'
import { optionalImportName } from './display-name.js'
import {
  buildPlusCatalogCatalogDescriptor,
  PLUS_CATALOG_PUBLIC_CATALOG,
} from './plus-catalog/plus-catalog-catalog.js'
import type { PlusConversionOutcome } from './plus-catalog/plus-conversion.js'
import { ensureFormatsThenDistribute, ensureEngineFormats } from './ensure-formats.js'
import { importModelBundle } from './bundle/bundle-import.js'
import {
  comparePluginCatalogManifestDrift,
  fetchPluginCatalogRemoteTree,
  normalizePluginCatalogDrift,
} from './plugin-catalog/plugin-catalog-tree-drift.js'
import {
  getPluginCatalogManifestEntry,
  PLUGIN_CATALOG_YOLO_MANIFEST,
} from './plugin-catalog/plugin-catalog-yolo-manifest.js'
import {
  fetchPlusAccessToken,
  isValidPlusApiKey,
  listPlusModels,
  plusInfoToDescriptor,
  requestPlusModelDownload,
  type PlusFetch,
} from './plus-catalog/plus-catalog-api.js'
import {
  resolvePlusDecode,
  UnsupportedPlusDecodeError,
  type PlusArtifactDecode,
} from './plus-catalog/plus-decode.js'
import { ModelUploadStore } from './upload/model-upload-store.js'
import {
  plusCatalogPlusRegistryId,
  ModelAvailabilityMapSchema,
  type ModelStudioActions,
  modelStudioActions,
} from './model-studio-actions.js'

const KEY_CUSTOM_MODELS = 'customModels'
const KEY_AVAILABILITY = 'availability'
const KEY_IMPORTED_NAMES = 'importedNames'
const ImportedNamesSchema = z.record(z.string(), z.string())
const CustomModelsSchema = z.array(CustomModelDescriptorSchema)
type AvailabilityMap = z.infer<typeof ModelAvailabilityMapSchema>

// ---------------------------------------------------------------------------
// Python script path resolution (mirrors addon-pipeline/detection-pipeline)
// ---------------------------------------------------------------------------

let pythonDirCache: string | undefined

function resolveAddonPythonDir(): string {
  if (pythonDirCache !== undefined) return pythonDirCache
  const candidates: string[] = []
  try {
    // Published package: resolve via node_modules
    const pkgPath = require.resolve('@camstack/addon-model-studio/package.json')
    candidates.push(path.join(path.dirname(pkgPath), 'python'))
  } catch {
    // Not resolvable from here — fall through to __dirname-relative candidates
  }
  candidates.push(
    path.join(__dirname, '../python'), // dist/model-studio.addon.js → ../python/
    path.join(__dirname, '../../python'),
    path.join(__dirname, '../../../python'),
  )
  const found = candidates.find((c) => fs.existsSync(path.join(c, 'convert.py')))
  if (found === undefined) {
    throw new Error(
      `addon-model-studio: python/convert.py not found. Searched:\n${candidates.join('\n')}`,
    )
  }
  pythonDirCache = found
  return found
}

// ---------------------------------------------------------------------------
// spawn-based runConvert implementation
// ---------------------------------------------------------------------------

function spawnRunConvert(
  jobPath: string,
  pythonPath: string,
  onProgress: (p: ConvertProgress) => void,
  _sessionId?: string,
): Promise<{ artifacts: readonly ConvertArtifact[] }> {
  return new Promise((resolve, reject) => {
    const pythonDir = resolveAddonPythonDir()
    const scriptPath = path.join(pythonDir, 'convert.py')
    const proc = spawn(pythonPath, [scriptPath, jobPath])
    const stderrChunks: Buffer[] = []
    let artifacts: readonly ConvertArtifact[] = []

    proc.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          continue
        }
        const resultParse = ConvertResultLineSchema.safeParse(parsed)
        if (resultParse.success) {
          artifacts = resultParse.data.result.artifacts
        } else {
          const progressParse = ConvertProgressSchema.safeParse(parsed)
          if (progressParse.success) {
            onProgress(progressParse.data)
          }
        }
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
      for (const line of chunk.toString().split('\n')) {
        const trimmed = line.trimEnd()
        if (trimmed.length === 0) continue
        onProgress({ phase: 'log', log: trimmed, detail: trimmed })
      }
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString()
        reject(new Error(`convert.py exited with code ${code}:\n${stderr}`))
      } else {
        resolve({ artifacts })
      }
    })

    proc.on('error', (err) => {
      reject(err)
    })
  })
}

/**
 * Model Studio — provides the `custom-model-registry` collection cap (hub only)
 * and the `model-convert` singleton cap (any node).
 *
 * P1 maintained the durable list of custom detection models and exposed them
 * so the detection pipeline can offer them in its model picker.
 *
 * P3 adds the `model-convert` provider on EVERY node so agents can run
 * local Python conversion without routing through the hub.
 * The `custom-model-registry` cap and all customActions are hub-only.
 */
/**
 * Addon settings. `plusCatalogPlusApiKey` is a SECRET (password field): consumed
 * only server-side by the plus catalog actions, sent only to api.frigate.video,
 * never logged, never included in any action response.
 */
interface ModelStudioConfig {
  readonly plusCatalogPlusApiKey: string
}

/** A name the operator typed replaces an existing row's name; a derived one never does. */
function nameOriginOf(operatorName: string | undefined): { nameOrigin?: UpsertNameOrigin } {
  return operatorName !== undefined ? { nameOrigin: 'operator' } : {}
}

/** Global-fetch adapter for the injected plus catalog client seam. */
const plusFetch: PlusFetch = async (url, init) => fetch(url, init)

export class ModelStudioAddon extends BaseAddon<ModelStudioConfig> {
  readonly id = 'model-studio'

  private modelsState: DurableState<CustomModelDescriptor[]> | null = null
  private availabilityState: DurableState<AvailabilityMap> | null = null
  /** modelId → the name a renamed registry row had before its first rename. */
  private importedNamesState: DurableState<ImportedNames> | null = null
  /** Lazily-built chunked-upload store (hub only) — see `upload/model-upload-store.ts`. */
  private uploadStore: ModelUploadStore | null = null

  /**
   * Module-Federation page declaration surfaced via the `addon-pages-source`
   * collection cap. Mirrors the manifest `pages[]` entry — admin-ui's
   * `<AddonPageLoader>` loads `addon_model_studio_page/page` from
   * `/api/addon-pages/model-studio/remoteEntry.js`.
   */
  readonly pages: readonly AddonPageDeclaration[] = [
    {
      id: 'model-studio',
      label: 'Model Studio',
      icon: 'boxes',
      path: '/addon/model-studio',
      remoteName: 'addon_model_studio_page',
      bundle: 'remoteEntry.js',
      // Dock into the sidebar's Detection group.
      section: 'detection',
    },
  ] as const

  constructor() {
    super({ plusCatalogPlusApiKey: '' })
  }

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'frigate-plus',
          title: 'plus catalog',
          description:
            'Credentials for importing your personal plus catalog models. Create an API key in your plus catalog account (https://plus.frigate.video → Settings → API keys; see docs.frigate.video/integrations/plus). The key is used only server-side against api.frigate.video and is never sent to the browser.',
          fields: [
            {
              type: 'password',
              key: 'plusCatalogPlusApiKey',
              label: 'plus catalog API key',
              description: 'Shape: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:40-hex-chars',
              showToggle: true,
            },
          ],
        },
      ],
    })
  }

  // ---------------------------------------------------------------------------
  // makeConvertDeps — wires real system APIs into the pure provider seam
  // ---------------------------------------------------------------------------

  private makeConvertDeps(): ModelConvertProviderDeps {
    return {
      modelsDir: () => this.resolveModelsDir(),
      pythonPath: async () => {
        const py = await this.ctx.deps.ensurePython()
        if (py === null) {
          throw new Error('model-convert: Python runtime unavailable on this node')
        }
        return py
      },
      ensureRequirements: async () => {
        const pythonDir = resolveAddonPythonDir()
        await this.ctx.deps.installPythonRequirements(path.join(pythonDir, 'requirements.txt'))
      },
      downloadOnnx: async (url: string, destDir: string, modelId: string) => {
        const filename = `camstack-${modelId}.onnx`
        const destPath = path.join(destDir, filename)
        return downloadFile(url, destPath)
      },
      writeJob: async (job: unknown) => {
        const tmpDir = this.ctx.dataDir ?? os.tmpdir()
        const jobPath = path.join(tmpDir, `model-convert-job-${crypto.randomUUID()}.json`)
        await fs.promises.writeFile(jobPath, JSON.stringify(job), 'utf8')
        return jobPath
      },
      runConvert: spawnRunConvert,
      onProgress: (p: ConvertProgress, sessionId?: string) => {
        this.ctx.eventBus.emit({
          id: crypto.randomUUID(),
          timestamp: new Date(),
          source: { type: 'addon', id: this.id },
          category: EventCategory.ModelConvertProgress,
          data: {
            kind: 'model-convert',
            phase: p.phase,
            pct: p.pct,
            detail: p.detail,
            log: p.log,
            sessionId,
          },
        })
      },
    }
  }

  protected async onInitialize(): Promise<AddonInitResult<ModelStudioActions>> {
    const state = this.state<CustomModelDescriptor[]>(KEY_CUSTOM_MODELS, CustomModelsSchema, [])
    this.modelsState = state
    this.availabilityState = this.state<AvailabilityMap>(
      KEY_AVAILABILITY,
      ModelAvailabilityMapSchema,
      {},
    )
    this.importedNamesState = this.state<ImportedNames>(KEY_IMPORTED_NAMES, ImportedNamesSchema, {})

    // Determine node role: hub vs agent
    const rawNode = this.ctx.kernel?.localNodeId ?? 'hub'
    const isHub = (rawNode.includes('/') ? rawNode.split('/')[0]! : rawNode) === 'hub'

    const pagesProvider: IAddonPageProvider = {
      id: this.id,
      listPages: () => this.pages,
    }

    const providers: ProviderRegistration[] = [
      {
        capability: modelConvertCapability,
        provider: buildModelConvertProvider(this.makeConvertDeps()),
      },
      { capability: addonPagesSourceCapability, provider: pagesProvider },
    ]

    if (isHub) {
      const registryProvider: ICustomModelRegistryProvider = {
        listModels: async () => state.get(),
        importModelBundle: async (input) => this.importModelBundle_(input),
      }
      providers.push({ capability: customModelRegistryCapability, provider: registryProvider })
      // A forgotten node's model files are gone with it (#265). Hub only: the
      // availability map lives where the registry does.
      providers.push({
        capability: nodeRemovalHookCapability,
        provider: createNodeRemovalHook({
          availability: () => this.availability_,
          logger: this.ctx.logger.child('node-removal'),
        }),
      })
    }

    return {
      providers,
      customActions: isHub ? modelStudioActions : undefined,
      actionHandlers: isHub
        ? {
            beginModelUpload: async (input) => (await this.getUploadStore()).begin(input),
            appendModelUpload: async (input) => (await this.getUploadStore()).append(input),
            commitModelUpload: async (input) => {
              const result = (await this.getUploadStore()).commit(input)
              this.ctx.logger.info('Model upload landed in modelsDir', {
                meta: { filename: result.filename, bytes: result.bytes, sha256: result.sha256 },
              })
              return result
            },
            abortModelUpload: async (input) => (await this.getUploadStore()).abort(input),
            registerCustomModel: async (input) =>
              this.registerCustomModel(input, {
                ensureEngines: true,
                nameOrigin: 'operator',
              }),
            renameCustomModel: async (input) => this.renameCustomModel_(input),
            ensureFormatsThenDistribute: async (input) =>
              this.ensureFormatsThenDistribute_(input.modelId),
            ensureModelFormats: async (input) =>
              this.ensureModelFormats_(input.modelId, input.formats),
            removeCustomModel: async (input) => this.removeCustomModel(input),
            removeModelFromNode: async (input) => this.removeModelFromNode(input),
            deleteSeedFromNode: async (input) => this.deleteSeedFromNode(input),
            listCustomModels: async () => {
              await this.pruneOrphanAvailability_()
              return this.listCustomModels()
            },
            distributeModel: async (input) => this.distributeModel(input),
            listAvailability: async () => {
              await this.pruneOrphanAvailability_()
              return this.availability_.get()
            },
            listPlusCatalogCatalog: async () =>
              PLUS_CATALOG_PUBLIC_CATALOG.map((c) => ({
                id: c.id,
                label: c.label,
                format: c.format,
                sizeMB: c.sizeMB,
                inputSize: c.inputSize,
                notes: c.notes,
              })),
            importPlusCatalogCatalogModel: async (input) =>
              this.importPlusCatalogCatalogModel(input),
            listPluginCatalogCatalog: async () => this.listPluginCatalogCatalog(),
            importPluginCatalogCatalogModel: async (input) =>
              this.importPluginCatalogCatalogFromManifest(input),
            tfliteSupport: async () => {
              const api = this.ctx.api
              if (!api) return { nodes: [] }
              const deps = this.recommendDeps()
              const nodes = await deps.listNodes()
              const supported: string[] = []
              for (const nId of nodes) {
                try {
                  const caps = await api.platformProbe.getCapabilities.query({ nodeId: nId })
                  if (caps.scores.some((sc) => sc.format === 'tflite' && sc.available)) {
                    supported.push(nId)
                  }
                } catch {
                  // Unreachable node — not a tflite offer.
                }
              }
              return { nodes: supported }
            },
            plusCatalogPlusStatus: async () => {
              const key = this.config.plusCatalogPlusApiKey ?? ''
              return { configured: key.length > 0, keyFormatValid: isValidPlusApiKey(key) }
            },
            plusCatalogPlusTest: async () => {
              try {
                await fetchPlusAccessToken(plusFetch, this.config.plusCatalogPlusApiKey ?? '')
                return { ok: true }
              } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : 'auth failed' }
              }
            },
            plusCatalogPlusListModels: async () =>
              listPlusModels(plusFetch, this.config.plusCatalogPlusApiKey ?? ''),
            importPlusCatalogModel: async (input) => this.importPlusCatalogModel(input),
            recommendConvertNode: async (input) => {
              const api = this.ctx.api
              if (!api) throw new Error('recommendConvertNode: ctx.api unavailable')
              return recommendConvertNode(input, {
                listNodes: async () => {
                  const capabilityProviders = await api.addons.listCapabilityProviders.query({
                    capName: 'model-convert',
                  })
                  return capabilityProviders.map((p) => {
                    // Remote agent providers are registered as "addonId@nodeId";
                    // hub-local providers are just "addonId" (bare name).
                    const atIdx = p.addonId.indexOf('@')
                    return atIdx !== -1 ? p.addonId.slice(atIdx + 1) : 'hub'
                  })
                },
                hardwareOf: async (nId) => {
                  // Pass the target node as the cap INPUT (`nodeId`) — the
                  // generated router's `resolveProvider` forwards to that node's
                  // platform-probe provider (local for hub, Moleculer proxy for a
                  // remote agent). The singleton mount ignores a `nodePin` context,
                  // so a pinned call would return the HUB's hardware for every node.
                  const hw = await api.platformProbe.getHardware.query({ nodeId: nId })
                  const caps = await api.platformProbe.getCapabilities.query({ nodeId: nId })
                  const hardware: NodeHardware = {
                    platform: hw.platform,
                    gpu: hw.gpu ?? undefined,
                    npu: hw.npu ?? undefined,
                    openvino: caps.scores.some((s) => s.format === 'openvino' && s.available),
                  }
                  return hardware
                },
              })
            },
            convertModel: async (input) => {
              const api = this.ctx.api
              if (!api) throw new Error('convertModel: ctx.api unavailable')
              const buildRecommendDeps = () => ({
                listNodes: async () => {
                  const capabilityProviders = await api.addons.listCapabilityProviders.query({
                    capName: 'model-convert',
                  })
                  return capabilityProviders.map((p) => {
                    const atIdx = p.addonId.indexOf('@')
                    return atIdx !== -1 ? p.addonId.slice(atIdx + 1) : 'hub'
                  })
                },
                hardwareOf: async (nId: string) => {
                  // Pass the target node as the cap INPUT (`nodeId`) — the
                  // generated router's `resolveProvider` forwards to that node's
                  // platform-probe provider (local for hub, Moleculer proxy for a
                  // remote agent). The singleton mount ignores a `nodePin` context,
                  // so a pinned call would return the HUB's hardware for every node.
                  const hw = await api.platformProbe.getHardware.query({ nodeId: nId })
                  const caps = await api.platformProbe.getCapabilities.query({ nodeId: nId })
                  const hardware: NodeHardware = {
                    platform: hw.platform,
                    gpu: hw.gpu ?? undefined,
                    npu: hw.npu ?? undefined,
                    openvino: caps.scores.some((s) => s.format === 'openvino' && s.available),
                  }
                  return hardware
                },
              })
              const availState = this.availability_
              const modState = this.state_
              return convertModel(input, {
                recommend: (i) => recommendConvertNode(i, buildRecommendDeps()),
                convert: (i, pin) => api.modelConvert.convert.mutate(i, pin),
                register: async (result) => {
                  await modState.update((prev) =>
                    upsertCustomModel(prev, { stepId: 'object-detection', entry: result.entry }),
                  )
                },
                markAvailable: async (nId, modelId, artifacts) => {
                  // Dedupe by format: openvino fp16 + int8 both map to 'openvino'
                  await availState.update((prev) => {
                    const seen = new Set<string>()
                    let next = prev
                    for (const artifact of artifacts) {
                      if (seen.has(artifact.format)) continue
                      seen.add(artifact.format)
                      next = upsertAvailability(next, modelId, nId, {
                        format: artifact.format,
                        sha256: '',
                        bytes: Math.round(artifact.sizeMB * 1e6),
                        at: Date.now(),
                      })
                    }
                    return next
                  })
                },
              })
            },
          }
        : undefined,
    }
  }

  /**
   * Build (once) the upload store, anchored at this node's writable data root:
   * staging under `<dataDir>/model-uploads`, commits into the SHARED
   * `<nodeDataDir>/models` — the same directory every inference addon loads
   * from, which is what makes the `camstack-local://` URL convention resolve.
   */
  private async getUploadStore(): Promise<ModelUploadStore> {
    if (this.uploadStore) return this.uploadStore
    const modelsDir = await this.resolveModelsDir()
    const stagingDir = path.join(this.ctx.dataDir ?? os.tmpdir(), 'model-uploads')
    this.uploadStore = new ModelUploadStore({ stagingDir, modelsDir })
    return this.uploadStore
  }

  private get state_(): DurableState<CustomModelDescriptor[]> {
    if (!this.modelsState) throw new Error('ModelStudioAddon: durable state not initialized')
    return this.modelsState
  }

  private get importedNames_(): DurableState<ImportedNames> {
    if (!this.importedNamesState) {
      throw new Error('ModelStudioAddon: imported-names state not initialized')
    }
    return this.importedNamesState
  }

  /**
   * Rename an imported registry row in place (`renameCustomModel` decides).
   * The id is untouched, so pins, availability and files are unaffected; the
   * pipeline's catalog view picks the new name up on its next registry read.
   */
  private async renameCustomModel_(input: {
    modelId: string
    name: string
  }): Promise<{ modelId: string; name: string }> {
    const names = await this.importedNames_.get()
    const outcome: { result?: RenameResult } = {}
    // Inside `update` so a concurrent upsert (a conversion landing) is not lost.
    await this.state_.update((prev) => {
      const renamed = renameCustomModel(prev, names, input.modelId, input.name)
      outcome.result = renamed
      return renamed.list
    })
    const result = outcome.result
    if (result === undefined) throw new Error('renameCustomModel: registry update did not run')
    await this.importedNames_.set(result.importedNames)
    this.ctx.logger.info('Renamed custom model', {
      meta: { modelId: input.modelId, name: result.name },
    })
    return { modelId: input.modelId, name: result.name }
  }

  private get availability_(): DurableState<AvailabilityMap> {
    if (!this.availabilityState) {
      throw new Error('ModelStudioAddon: availability state not initialized')
    }
    return this.availabilityState
  }

  private async distributeModel(input: {
    modelId: string
    nodeId: string
    /**
     * The SHARED `ModelFormat`, not a hand-written subset. This was spelled out
     * as a five-member union that had fallen a format behind `MODEL_FORMATS`,
     * so an action carrying `gguf` (llm managed models) failed to typecheck
     * even though `modelDistributor.distributeModel` takes `z.enum(MODEL_FORMATS)`
     * and accepts it.
     */
    format: ModelFormat
  }): Promise<{ ok: boolean; sha256: string; bytes: number }> {
    const list = await this.state_.get()
    const descriptor = list.find((m) => m.entry.id === input.modelId)
    if (!descriptor) {
      throw new Error(`distributeModel: model "${input.modelId}" is not registered`)
    }
    const formatEntry = descriptor.entry.formats[input.format]
    if (formatEntry === undefined) {
      throw new Error(
        `distributeModel: model "${input.modelId}" has no ${input.format} format in the Library`,
      )
    }
    const api = this.ctx.api
    if (!api) throw new Error('distributeModel: ctx.api unavailable')

    // Remote URLs (HF / plus catalog public / …): download on the TARGET node —
    // hub is not a required staging disk.
    if (/^https?:\/\//i.test(formatEntry.url)) {
      const downloaded = await api.pipelineExecutor.downloadModel.mutate(
        {
          modelId: input.modelId,
          format: input.format,
          addonId: descriptor.stepId,
        },
        nodePin(input.nodeId),
      )
      const bytes = Math.round(downloaded.sizeMB * 1e6)
      await this.availability_.update((prev) =>
        upsertAvailability(prev, input.modelId, input.nodeId, {
          format: input.format,
          sha256: '',
          bytes,
          at: Date.now(),
        }),
      )
      this.ctx.logger.info('Downloaded custom model on node', {
        meta: {
          modelId: input.modelId,
          nodeId: input.nodeId,
          format: input.format,
          bytes,
        },
      })
      return { ok: true, sha256: '', bytes }
    }

    // camstack-local:// — artifact must already live on hub; push via distributor.
    const res = await api.modelDistributor.distributeModel.mutate({
      targetNodeId: input.nodeId,
      modelId: input.modelId,
      format: input.format,
      entry: descriptor.entry,
    })
    await this.availability_.update((prev) =>
      upsertAvailability(prev, input.modelId, input.nodeId, {
        format: input.format,
        sha256: res.sha256,
        bytes: res.bytes,
        at: Date.now(),
      }),
    )
    this.ctx.logger.info('Distributed custom model', {
      meta: {
        modelId: input.modelId,
        nodeId: input.nodeId,
        format: input.format,
        bytes: res.bytes,
      },
    })
    return { ok: res.ok, sha256: res.sha256, bytes: res.bytes }
  }

  /** listNodes/hardwareOf deps for `recommendConvertNode` — shared by the
   *  convert actions and the plus catalog auto-conversion. */
  private recommendDeps() {
    const api = this.ctx.api
    if (!api) throw new Error('model-studio: ctx.api unavailable')
    return {
      listNodes: async () => {
        const capabilityProviders = await api.addons.listCapabilityProviders.query({
          capName: 'model-convert',
        })
        return capabilityProviders.map((p) => {
          const atIdx = p.addonId.indexOf('@')
          return atIdx !== -1 ? p.addonId.slice(atIdx + 1) : 'hub'
        })
      },
      hardwareOf: async (nId: string) => {
        const hw = await api.platformProbe.getHardware.query({ nodeId: nId })
        const caps = await api.platformProbe.getCapabilities.query({ nodeId: nId })
        const hardware: NodeHardware = {
          platform: hw.platform,
          gpu: hw.gpu ?? undefined,
          npu: hw.npu ?? undefined,
          openvino: caps.scores.some((s) => s.format === 'openvino' && s.available),
        }
        return hardware
      },
    }
  }

  /** sha256 of a file on disk (streamed). */
  private static async fileSha256(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256')
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(filePath)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', () => resolve())
        .on('error', reject)
    })
    return hash.digest('hex')
  }

  /**
   * Projection of the local plugin catalog YOLO manifesto plus a read-only HF drift
   * check. Network errors become `unavailable` rows — the manifesto is never
   * mutated and nothing is auto-imported.
   */
  private async listPluginCatalogCatalog(): Promise<{
    entries: typeof PLUGIN_CATALOG_YOLO_MANIFEST
    drift: ReturnType<typeof comparePluginCatalogManifestDrift>
  }> {
    try {
      const tree = await fetchPluginCatalogRemoteTree({ fetchImpl: fetch })
      return {
        entries: PLUGIN_CATALOG_YOLO_MANIFEST,
        drift: comparePluginCatalogManifestDrift(PLUGIN_CATALOG_YOLO_MANIFEST, tree).map(
          normalizePluginCatalogDrift,
        ),
      }
    } catch (err) {
      const details = err instanceof Error ? err.message : 'Hugging Face tree unavailable'
      return {
        entries: PLUGIN_CATALOG_YOLO_MANIFEST,
        drift: PLUGIN_CATALOG_YOLO_MANIFEST.map((entry) => ({
          manifestId: entry.id,
          status: 'unavailable' as const,
          details,
        })),
      }
    }
  }

  /**
   * Register one manifesto entry by id into the Library. Host/repo/revision
   * stay server-owned. Artifacts are NOT staged on the hub — optional
   * `targetNodeId` lands the HF URL on that node via download-on-target.
   */
  private async importPluginCatalogCatalogFromManifest(input: {
    manifestId: string
    name?: string
    targetNodeId?: string
  }): Promise<CustomModelDescriptor> {
    const name = optionalImportName(input.name)
    const entry = getPluginCatalogManifestEntry(input.manifestId)
    if (!entry) {
      throw new Error(`importPluginCatalogCatalogModel: unknown manifest id "${input.manifestId}"`)
    }
    let drift
    try {
      const tree = await fetchPluginCatalogRemoteTree({ fetchImpl: fetch })
      const row = comparePluginCatalogManifestDrift(
        PLUGIN_CATALOG_YOLO_MANIFEST.filter((e) => e.id === input.manifestId),
        tree,
      )[0]
      drift = normalizePluginCatalogDrift(
        row ?? {
          manifestId: input.manifestId,
          status: 'missing',
          details: 'entry missing from manifesto',
        },
      )
    } catch (err) {
      drift = {
        manifestId: input.manifestId,
        status: 'unavailable' as const,
        details: err instanceof Error ? err.message : 'Hugging Face tree unavailable',
      }
    }
    if (drift.status !== 'ok') {
      throw new Error(
        `importPluginCatalogCatalogModel: entry "${entry.id}" is blocked by drift (${drift.status}${drift.details ? `: ${drift.details}` : ''})`,
      )
    }

    const built = buildPluginCatalogRegistryDescriptor(entry)
    const descriptor: CustomModelDescriptor =
      name !== undefined ? { stepId: built.stepId, entry: { ...built.entry, name } } : built
    await this.registerCustomModel(descriptor, nameOriginOf(name))
    if (input.targetNodeId !== undefined && input.targetNodeId.length > 0) {
      await this.distributeModel({
        modelId: descriptor.entry.id,
        nodeId: input.targetNodeId,
        format: entry.format,
      })
    }
    this.ctx.logger.info('Registered plugin catalog catalog model', {
      meta: {
        manifestId: input.manifestId,
        modelId: descriptor.entry.id,
        format: entry.format,
        ...(input.targetNodeId !== undefined ? { targetNodeId: input.targetNodeId } : {}),
      },
    })
    return descriptor
  }

  /**
   * Register a curated PUBLIC plus catalog catalog model into the Library. The
   * entry keeps its public URL — no hub staging. Optional `targetNodeId`
   * downloads on that node (same path as Library → Distribute).
   */
  private async importPlusCatalogCatalogModel(input: {
    catalogId: string
    modelId?: string
    name?: string
    targetNodeId?: string
  }): Promise<{ ok: true; modelId: string; bytes: number }> {
    const cat = PLUS_CATALOG_PUBLIC_CATALOG.find((c) => c.id === input.catalogId)
    if (!cat)
      throw new Error(`importPlusCatalogCatalogModel: unknown catalog id "${input.catalogId}"`)
    const name = optionalImportName(input.name)
    const descriptor = buildPlusCatalogCatalogDescriptor(input.catalogId, {
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(name !== undefined ? { name } : {}),
    })
    await this.registerCustomModel(descriptor, nameOriginOf(name))
    let bytes = Math.round(cat.sizeMB * 1e6)
    if (input.targetNodeId !== undefined && input.targetNodeId.length > 0) {
      const landed = await this.distributeModel({
        modelId: descriptor.entry.id,
        nodeId: input.targetNodeId,
        format: cat.format,
      })
      bytes = landed.bytes > 0 ? landed.bytes : bytes
    }
    this.ctx.logger.info('Registered plus catalog catalog model', {
      meta: {
        catalogId: input.catalogId,
        modelId: descriptor.entry.id,
        ...(input.targetNodeId !== undefined ? { targetNodeId: input.targetNodeId } : {}),
        bytes,
      },
    })
    return { ok: true, modelId: descriptor.entry.id, bytes }
  }

  /**
   * Import one of the operator's personal plus catalog models: resolve metadata +
   * presigned URL with the SECRET key (server-side only), download into the
   * hub's modelsDir, and register with the model-type-derived characteristics
   * (format, decode, input size, labelmap — nothing hand-typed). The artifact
   * is hub-local: other nodes get it via Models → Distribute.
   */
  private async importPlusCatalogModel(input: {
    plusModelId: string
    modelId?: string
    name?: string
    format?: 'onnx' | 'tflite'
    ensureFormats?: readonly ('openvino' | 'coreml')[]
  }): Promise<{
    ok: true
    modelId: string
    bytes: number
    conversions: readonly PlusConversionOutcome[]
  }> {
    const modelId = plusCatalogPlusRegistryId(input.plusModelId)
    const operatorName = optionalImportName(input.name)
    const key = this.config.plusCatalogPlusApiKey ?? ''
    const { info, downloadUrl } = await requestPlusModelDownload(plusFetch, key, input.plusModelId)
    let decode: PlusArtifactDecode
    try {
      decode = resolvePlusDecode(info, input.format)
    } catch (err) {
      if (err instanceof UnsupportedPlusDecodeError) {
        this.ctx.logger.warn('plus catalog model import refused — no decoder', {
          meta: {
            plusModelId: input.plusModelId,
            type: err.type,
            format: err.format,
            detectors: [...err.detectors],
          },
        })
      }
      throw err
    }
    const filename = `${modelId}${decode.extension}`
    const modelsDir = await this.resolveModelsDir()
    const destPath = path.join(modelsDir, filename)
    await downloadFile(downloadUrl, destPath)
    const bytes = (await fs.promises.stat(destPath)).size
    if (bytes < 10_000) {
      await fs.promises.rm(destPath, { force: true })
      throw new Error(
        `importPlusCatalogModel: downloaded only ${bytes} bytes — the signed URL likely expired or the response was an error page`,
      )
    }
    const sha256 = await ModelStudioAddon.fileSha256(destPath)
    const descriptor = plusInfoToDescriptor(info, {
      modelId,
      name: operatorName ?? `plus catalog ${info.type} (${input.plusModelId.slice(0, 8)})`,
      filename,
      sizeMB: Number((bytes / 1e6).toFixed(1)),
      ...(input.format !== undefined ? { format: input.format } : {}),
    })
    // Registry only — engine ensure uses a fresh Plus signed URL below.
    await this.registerCustomModel(descriptor, {
      ensureEngines: false,
      ...nameOriginOf(operatorName),
    })
    await this.availability_.update((prev) =>
      upsertAvailability(prev, modelId, 'hub', {
        format: decode.format,
        sha256,
        bytes,
        at: Date.now(),
      }),
    )
    this.ctx.logger.info('Imported plus catalog model', {
      meta: {
        plusModelId: input.plusModelId,
        modelId,
        type: info.type,
        bytes,
        format: decode.format,
      },
    })

    const wanted = input.ensureFormats ?? []
    let conversions: readonly PlusConversionOutcome[] = []
    if (decode.format === 'onnx' && wanted.length > 0) {
      const ensured = await ensureEngineFormats(
        descriptor.entry,
        this.plusConversionDeps(
          async () =>
            (await requestPlusModelDownload(plusFetch, key, input.plusModelId)).downloadUrl,
          descriptor.stepId,
        ),
        { targetFormats: wanted },
      )
      conversions = ensured.conversions
      this.ctx.logger.info('plus catalog import — engine conversions', {
        meta: { modelId, outcomes: conversions.map((o) => ({ ...o })) },
      })
    }
    return { ok: true, modelId, bytes, conversions }
  }

  private async registerCustomModel(
    input: CustomModelDescriptor,
    opts: { ensureEngines?: boolean; nameOrigin?: UpsertNameOrigin } = {},
  ): Promise<{ ok: true; conversions: readonly PlusConversionOutcome[] }> {
    if (!input.stepId.trim()) throw new Error('registerCustomModel: stepId is required')
    if (!input.entry.id.trim()) throw new Error('registerCustomModel: entry.id is required')
    await this.state_.update((prev) => upsertCustomModel(prev, input, opts.nameOrigin))
    this.ctx.logger.info('Registered custom model', {
      meta: { modelId: input.entry.id, stepId: input.stepId },
    })

    let conversions: readonly PlusConversionOutcome[] = []
    if (opts.ensureEngines === true && input.entry.formats.onnx !== undefined) {
      const onnxUrl = input.entry.formats.onnx.url
      if (typeof onnxUrl === 'string' && onnxUrl.length > 0) {
        const deps = this.plusConversionDeps(() => Promise.resolve(onnxUrl), input.stepId)
        const ensured = await ensureEngineFormats(input.entry, deps)
        conversions = ensured.conversions
        if (conversions.length > 0) {
          this.ctx.logger.info('Custom model — engine conversions', {
            meta: {
              modelId: input.entry.id,
              outcomes: conversions.map((o) => ({ ...o })),
            },
          })
        }
      }
    }
    return { ok: true, conversions }
  }

  private plusConversionDeps(
    freshSourceUrl: () => Promise<string>,
    stepId: string,
  ): Parameters<typeof ensureEngineFormats>[1] {
    const api = this.ctx.api
    return {
      recommend: (i) => recommendConvertNode(i, this.recommendDeps()),
      convert: async (convertInput, nId) => {
        if (!api) throw new Error('modelConvert unavailable')
        return api.modelConvert.convert.mutate(convertInput, nodePin(nId))
      },
      freshSourceUrl,
      upsertEntry: async (entry) => {
        await this.state_.update((prev) => upsertCustomModel(prev, { stepId, entry }))
      },
      markAvailable: async (nId, mId, artifacts) => {
        await this.availability_.update((prev) => {
          const seen = new Set<string>()
          let next = prev
          for (const artifact of artifacts) {
            if (seen.has(artifact.format)) continue
            seen.add(artifact.format)
            next = upsertAvailability(next, mId, nId, {
              format: artifact.format,
              sha256: '',
              bytes: Math.round(artifact.sizeMB * 1e6),
              at: Date.now(),
            })
          }
          return next
        })
      },
    }
  }

  private async ensureModelFormats_(
    modelId: string,
    formats: readonly ('openvino' | 'coreml')[],
  ): Promise<{ conversions: readonly PlusConversionOutcome[] }> {
    const list = await this.state_.get()
    const row = list.find((m) => m.entry.id === modelId)
    if (row === undefined) {
      throw new Error(`ensureModelFormats: model "${modelId}" is not registered`)
    }
    const onnxUrl = row.entry.formats.onnx?.url
    if (typeof onnxUrl !== 'string' || onnxUrl.length === 0) {
      throw new Error(`ensureModelFormats: model "${modelId}" has no ONNX to convert from`)
    }
    const ensured = await ensureEngineFormats(
      row.entry,
      this.plusConversionDeps(async () => {
        const fresh = (await this.state_.get()).find((m) => m.entry.id === modelId)?.entry
        const url = fresh?.formats.onnx?.url ?? onnxUrl
        if (typeof url !== 'string' || url.length === 0) {
          throw new Error(`ensureModelFormats: no ONNX url for "${modelId}"`)
        }
        return url
      }, row.stepId),
      { targetFormats: formats },
    )
    this.ctx.logger.info('ensureModelFormats', {
      meta: { modelId, outcomes: ensured.conversions.map((o) => ({ ...o })) },
    })
    return { conversions: ensured.conversions }
  }

  /** `custom-model-registry.importModelBundle` (D806); the body is `bundle/bundle-import.ts`. */
  private async importModelBundle_(
    input: ImportModelBundleInput,
  ): Promise<ImportModelBundleResult> {
    const peerBytes = this.ctx.peerBytes
    if (peerBytes === undefined) {
      return {
        kind: 'refused',
        reason: 'transfer-failed',
        detail: 'no peer-bytes facility in this process',
      }
    }
    const modelsDir = await this.resolveModelsDir()
    const nodeId = this.ctx.kernel?.localNodeId ?? 'hub'
    const result = await importModelBundle(input, {
      modelsDir,
      stagingDir: path.join(this.ctx.dataDir ?? os.tmpdir(), 'model-bundles'),
      openTicket: (ticket) => peerBytes.open(ticket),
      listModels: async () => this.state_.get(),
      upsert: async (descriptor) => {
        await this.state_.update((prev) => upsertCustomModel(prev, descriptor, 'operator'))
      },
      markHubAvailable: async (modelId, format, bytes) => {
        await this.availability_.update((prev) =>
          upsertAvailability(prev, modelId, nodeId.split('/')[0] ?? 'hub', {
            format,
            sha256: '',
            bytes,
            at: Date.now(),
          }),
        )
      },
      distribute: async (modelId) => {
        const ensured = await this.ensureFormatsThenDistribute_(modelId)
        return ensured.distributed.map((d) => ({
          modelId,
          nodeId: d.nodeId,
          format: d.format,
          ok: d.ok,
          ...(d.error !== undefined ? { error: d.error } : {}),
        }))
      },
      newId: () => crypto.randomUUID(),
    })
    if (result.kind === 'refused') {
      this.ctx.logger.warn('Model bundle import refused', {
        meta: {
          reason: result.reason,
          detail: result.detail,
          modelIds: input.entries.map((e) => e.id),
        },
      })
    } else {
      this.ctx.logger.info('Model bundle imported', {
        meta: { modelIds: [...result.modelIds], distributed: result.distributed.length },
      })
    }
    return result
  }

  private async ensureFormatsThenDistribute_(modelId: string): Promise<{
    conversions: readonly PlusConversionOutcome[]
    distributed: readonly {
      nodeId: string
      format: ModelFormat
      ok: boolean
      error?: string
      bytes?: number
    }[]
  }> {
    const api = this.ctx.api
    if (!api) throw new Error('ensureFormatsThenDistribute: ctx.api unavailable')

    const getEntry = async () => {
      const list = await this.state_.get()
      return list.find((m) => m.entry.id === modelId)?.entry
    }
    const entry = await getEntry()
    if (entry === undefined) {
      throw new Error(`ensureFormatsThenDistribute: model "${modelId}" is not registered`)
    }
    const onnxUrl = entry.formats.onnx?.url
    const stepId =
      (await this.state_.get()).find((m) => m.entry.id === modelId)?.stepId ?? 'object-detection'

    return ensureFormatsThenDistribute(modelId, {
      ...this.plusConversionDeps(async () => {
        const fresh = await getEntry()
        const url = fresh?.formats.onnx?.url ?? onnxUrl
        if (typeof url !== 'string' || url.length === 0) {
          throw new Error(`ensureFormatsThenDistribute: no ONNX url for "${modelId}"`)
        }
        return url
      }, stepId),
      getEntry,
      listAgentNodeIds: async () => {
        const dir = await api.nodes.directory.query()
        return dir.nodes.filter((n) => n.isOnline && !n.isHub).map((n) => n.id)
      },
      distribute: async (mId, nodeId, format) => {
        const res = await this.distributeModel({ modelId: mId, nodeId, format })
        return { sha256: res.sha256, bytes: res.bytes }
      },
    })
  }

  /**
   * Delete one CamStack seed format on one node. Physically removes files from
   * that node's modelsDir via `pipelineExecutor.deleteModel` + `nodePin`.
   */
  private async deleteSeedFromNode(input: {
    addonId: string
    modelId: string
    format: ModelFormat
    nodeId: string
  }): Promise<{ success: true }> {
    const api = this.ctx.api
    if (!api) {
      throw new Error('deleteSeedFromNode: API not available')
    }
    await api.pipelineExecutor.deleteModel.mutate(
      {
        addonId: input.addonId,
        modelId: input.modelId,
        format: input.format,
      },
      nodePin(input.nodeId),
    )
    this.ctx.logger.info('CamStack seed deleted from node disk', {
      meta: {
        modelId: input.modelId,
        format: input.format,
        nodeId: input.nodeId,
        addonId: input.addonId,
      },
    })
    return { success: true }
  }

  /**
   * Delete one format on one node. Registry row stays; only that availability
   * chip is cleared. Pins are left alone — re-Send to node restores files.
   */
  private async removeModelFromNode(input: {
    modelId: string
    nodeId: string
    format: ModelFormat
  }): Promise<{ deleted: boolean; clearedAvailability: boolean }> {
    const list = await this.state_.get()
    const descriptor = list.find((m) => m.entry.id === input.modelId)
    if (!descriptor) {
      throw new Error(`removeModelFromNode: model "${input.modelId}" is not registered`)
    }
    if (descriptor.entry.formats[input.format] === undefined) {
      throw new Error(
        `removeModelFromNode: model "${input.modelId}" has no ${input.format} format in the Library`,
      )
    }

    let deleted = false
    const api = this.ctx.api
    try {
      if (api) {
        await api.pipelineExecutor.deleteModel.mutate(
          {
            addonId: descriptor.stepId,
            modelId: input.modelId,
            format: input.format,
          },
          nodePin(input.nodeId),
        )
        deleted = true
      }
    } catch (err) {
      this.ctx.logger.warn('removeModelFromNode: remote delete failed (continuing)', {
        meta: {
          modelId: input.modelId,
          nodeId: input.nodeId,
          format: input.format,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }

    if (input.nodeId === 'hub') {
      try {
        const modelsDir = await this.resolveModelsDir()
        deleteModelFromDisk(modelsDir, descriptor.entry, input.format)
        deleted = true
      } catch (err) {
        this.ctx.logger.warn('removeModelFromNode: hub disk wipe failed', {
          meta: {
            modelId: input.modelId,
            format: input.format,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }

    let clearedAvailability = false
    await this.availability_.update((prev) => {
      const result = clearAvailabilityFormat(prev, input.modelId, input.nodeId, input.format)
      clearedAvailability = result.cleared
      return result.next
    })

    this.ctx.logger.info('Removed custom model format from node', {
      meta: {
        modelId: input.modelId,
        nodeId: input.nodeId,
        format: input.format,
        deleted,
        clearedAvailability,
      },
    })
    return { deleted, clearedAvailability }
  }

  /**
   * Full purge of a Library model: delete artifacts on every node that had
   * them, clear availability (so Sources no longer shows "imported"), strip
   * pipeline pins that named this modelId (agents revert to hardware defaults
   * for that step), then drop the registry row.
   */
  private async removeCustomModel(input: {
    modelId: string
  }): Promise<{ removed: boolean; deletedNodes: readonly string[]; clearedPins: number }> {
    const list = await this.state_.get()
    const descriptor = list.find((m) => m.entry.id === input.modelId)
    if (!descriptor) {
      // Registry already empty but availability can still claim "imported".
      await this.availability_.update((prev) => clearAvailability(prev, input.modelId).next)
      return { removed: false, deletedNodes: [], clearedPins: 0 }
    }

    const formats = (Object.keys(descriptor.entry.formats) as ModelFormat[]).filter(
      (f) => descriptor.entry.formats[f] !== undefined,
    )
    const avail = await this.availability_.get()
    const nodeIds = new Set<string>(['hub', ...Object.keys(avail[input.modelId] ?? {})])
    const deletedNodes: string[] = []
    const api = this.ctx.api

    // Delete while the registry still lists the entry so
    // `pipelineExecutor.deleteModel` can resolve it on remote nodes.
    for (const nodeId of nodeIds) {
      let anyDeleted = false
      for (const format of formats) {
        try {
          if (api) {
            await api.pipelineExecutor.deleteModel.mutate(
              {
                addonId: descriptor.stepId,
                modelId: input.modelId,
                format,
              },
              nodePin(nodeId),
            )
            anyDeleted = true
          }
        } catch (err) {
          this.ctx.logger.warn('removeCustomModel: remote delete failed (continuing)', {
            meta: {
              modelId: input.modelId,
              nodeId,
              format,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }
      }
      if (anyDeleted) deletedNodes.push(nodeId)
    }

    // Hub-local wipe even if the executor path missed (camstack-local basename).
    try {
      const modelsDir = await this.resolveModelsDir()
      for (const format of formats) {
        deleteModelFromDisk(modelsDir, descriptor.entry, format)
      }
    } catch (err) {
      this.ctx.logger.warn('removeCustomModel: hub disk wipe failed', {
        meta: {
          modelId: input.modelId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }

    let clearedPins = 0
    if (api) {
      try {
        clearedPins += await this.clearAgentModelPins(input.modelId)
      } catch (err) {
        this.ctx.logger.warn('removeCustomModel: agent pin clear failed', {
          meta: {
            modelId: input.modelId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }

    await this.availability_.update((prev) => clearAvailability(prev, input.modelId).next)

    let removed = false
    await this.state_.update((prev) => {
      const result = removeCustomModel(prev, input.modelId)
      removed = result.removed
      return result.next
    })
    await this.importedNames_.update((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => id !== input.modelId)),
    )

    this.ctx.logger.info('Removed custom model', {
      meta: { modelId: input.modelId, removed, deletedNodes, clearedPins },
    })
    return { removed, deletedNodes, clearedPins }
  }

  /** Strip `modelId` from every agent's inferenceDevices step pins. */
  private async clearAgentModelPins(modelId: string): Promise<number> {
    const api = this.ctx.api
    if (!api) return 0
    const agents = await api.pipelineOrchestrator.listAgentSettings.query()
    let cleared = 0
    for (const agent of agents) {
      const devices = agent.settings.inferenceDevices
      if (devices === undefined) continue
      const { next, cleared: n } = stripModelIdFromInferenceDevices(devices, modelId)
      if (n === 0) continue
      await api.pipelineOrchestrator.setAgentInferenceDevices.mutate({
        agentNodeId: agent.nodeId,
        inferenceDevices: next,
      })
      cleared += n
    }
    return cleared
  }

  private async listCustomModels(): Promise<readonly CustomModelDescriptor[]> {
    return this.state_.get()
  }

  /**
   * Self-heal: drop availability rows for modelIds no longer in the Library
   * registry. Import and Library both trigger this so an orphan cannot keep
   * Sources stuck on "imported" after a registry wipe.
   */
  private async pruneOrphanAvailability_(): Promise<void> {
    try {
      const [avail, models] = await Promise.all([this.availability_.get(), this.state_.get()])
      const registered = new Set(models.map((m) => m.entry.id))
      const { next, pruned } = pruneOrphanAvailability(avail, registered)
      if (pruned.length === 0) return
      await this.availability_.update(() => next)
      this.ctx.logger.info('Pruned orphan model availability', {
        meta: { pruned },
      })
    } catch (err) {
      // Never fail listCustomModels / listAvailability because of a prune —
      // that froze every plugin catalog Import button as "blocked".
      this.ctx.logger.warn('pruneOrphanAvailability failed (continuing)', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
