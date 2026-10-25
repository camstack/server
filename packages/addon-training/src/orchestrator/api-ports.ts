/**
 * The engine's ports over `ctx.api` — the only file of the orchestrator that
 * knows cap names. Addons never import each other; every cross-addon step
 * here is a capability call (D2 / "ctx.api is the only cross-addon layer").
 *
 * Provider calls are keyed by `entryId`. This port resolves each entry to its
 * owning addon and pins the collection with `{ addonId }` (broker posture).
 */
import type { AddonApi } from '@camstack/types'
import type {
  CorpusPort,
  DatasetPort,
  DetectorDevice,
  PinPort,
  ProviderPort,
  RegistryPort,
} from './ports.js'

export const DETECTOR_STEP = 'object-detection'
const REGISTRY_CAP = 'custom-model-registry'

/** The provider cap, with entryId → owning addon resolution for collection pins. */
export function providerPort(api: AddonApi): ProviderPort {
  const p = api.trainingProvider

  const addonForEntry = async (entryId: string): Promise<string> => {
    const entries = await p.listEntries.query({})
    const entry = entries.find((e) => e.entryId === entryId)
    if (entry === undefined) throw new Error(`unknown training provider entry "${entryId}"`)
    return entry.addonId
  }

  const addonForType = async (typeId: string): Promise<string> => {
    const types = await p.describeTypes.query({})
    const type = types.find((t) => t.typeId === typeId)
    if (type === undefined) throw new Error(`unknown training provider type "${typeId}"`)
    return type.addonId
  }

  return {
    describe: () => p.describe.query({}),
    describeTypes: () => p.describeTypes.query({}),
    listEntries: () => p.listEntries.query({}),
    createEntry: async (i) => {
      const addonId = await addonForType(i.typeId)
      return p.createEntry.mutate({ ...i, addonId })
    },
    updateEntry: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.updateEntry.mutate({ ...i, addonId })
    },
    deleteEntry: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.deleteEntry.mutate({ ...i, addonId })
    },
    validateCredentials: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.validateCredentials.mutate({ ...i, addonId })
    },
    estimateJob: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.estimateJob.query({ ...i, addonId })
    },
    uploadDataset: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.uploadDataset.mutate({ ...i, addonId })
    },
    submitJob: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.submitJob.mutate({ ...i, addonId })
    },
    getJob: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.getJob.query({ ...i, addonId })
    },
    listJobEvents: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.listJobEvents.query({ ...i, addonId })
    },
    cancelJob: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.cancelJob.mutate({ ...i, addonId })
    },
    readResult: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.readResult.mutate({ ...i, addonId })
    },
    offerArtifact: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.offerArtifact.mutate({ ...i, addonId })
    },
    cleanupJob: async (i) => {
      const addonId = await addonForEntry(i.entryId)
      return p.cleanupJob.mutate({ ...i, addonId })
    },
    listJobs: async (i) => {
      if (i.entryId !== undefined) {
        const addonId = await addonForEntry(i.entryId)
        return p.listJobs.query({ ...i, addonId })
      }
      const types = await p.describeTypes.query({})
      const seen = new Set<string>()
      const rows = await Promise.all(
        types.map(async (t) => {
          if (seen.has(t.addonId)) return []
          seen.add(t.addonId)
          return p.listJobs.query({ addonId: t.addonId })
        }),
      )
      return rows.flat()
    },
  }
}

export function datasetPort(api: AddonApi): DatasetPort {
  return {
    offerArchive: async (input) => {
      const offered = await api.pipelineAnalytics.offerRetrainArchive.mutate({
        filter: { ...input.filter },
        layout: input.layout,
      })
      return { ticket: offered.ticket, frames: offered.frames }
    },
  }
}

export function corpusPort(api: AddonApi): CorpusPort {
  return {
    resolve: (selection) => api.pipelineAnalytics.resolveRetrainTrainingCorpus.query(selection),
  }
}

/** Model Studio's registry: the hub's provider of `custom-model-registry`. */
export function registryPort(api: AddonApi): RegistryPort {
  return {
    importBundle: async (input) => {
      const providers = await api.addons.listCapabilityProviders.query({ capName: REGISTRY_CAP })
      const hub = providers.find((prov) => !prov.addonId.includes('@'))
      if (hub === undefined)
        throw new Error('no custom-model registry on the hub — is Model Studio installed?')
      return api.customModelRegistry.importModelBundle.mutate({ ...input, addonId: hub.addonId })
    },
  }
}

export function pinPort(api: AddonApi): PinPort {
  const orchestrator = api.pipelineOrchestrator
  return {
    listDetectorDevices: async () => {
      const agents = await orchestrator.listAgentSettings.query()
      const out: DetectorDevice[] = []
      for (const agent of agents) {
        if (agent.settings.detect === false) continue
        const node = await orchestrator.getNodeInferenceDevices.query({ nodeId: agent.nodeId })
        for (const device of node.devices) {
          if (!device.enabled || device.exclusion !== null) continue
          out.push({
            nodeId: agent.nodeId,
            deviceKey: device.key,
            pinnedModelId: device.steps?.[DETECTOR_STEP]?.modelId ?? device.defaultModelId,
          })
        }
      }
      return out
    },
    getPin: async (nodeId, deviceKey) => {
      const settings = await orchestrator.getAgentSettings.query({ agentNodeId: nodeId })
      return settings?.inferenceDevices?.[deviceKey]?.steps?.[DETECTOR_STEP]?.modelId ?? null
    },
    setPin: async (nodeId, deviceKey, modelId) => {
      const settings = await orchestrator.getAgentSettings.query({ agentNodeId: nodeId })
      const devices = settings?.inferenceDevices ?? {}
      const entry = devices[deviceKey] ?? { enabled: true }
      const { [DETECTOR_STEP]: current, ...otherSteps } = entry.steps ?? {}
      const { modelId: _old, ...keep } = current ?? {}
      const detector = modelId === null ? keep : { ...keep, modelId }
      const steps =
        Object.keys(detector).length > 0 ? { ...otherSteps, [DETECTOR_STEP]: detector } : otherSteps
      const { steps: _oldSteps, ...rest } = entry
      await orchestrator.setAgentInferenceDevices.mutate({
        agentNodeId: nodeId,
        inferenceDevices: {
          ...devices,
          [deviceKey]: { ...rest, ...(Object.keys(steps).length > 0 ? { steps } : {}) },
        },
      })
    },
  }
}
