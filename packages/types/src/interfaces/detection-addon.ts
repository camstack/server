import type { ICamstackAddon } from './addon.js'
import type { IPipelineSlotProvider } from './pipeline-slot.js'
import type { ConfigUISchema } from './config-ui.js'
import type { ClassMapDefinition, LabelDefinition } from '../types/labels.js'
import type { ModelCatalogEntry, DetectionModel } from '../types/models.js'
import type { ProbeResult } from '../types/config.js'

export interface IDetectionAddon
  extends Omit<ICamstackAddon, 'getConfigSchema' | 'getModelCatalog'>,
    IPipelineSlotProvider {
  getConfigSchema(): Promise<ConfigUISchema>
  getClassMap(): Promise<ClassMapDefinition>
  getModelCatalog(): Promise<ModelCatalogEntry[]>
  getAvailableModels(): Promise<DetectionModel[]>
  getActiveLabels(): Promise<readonly LabelDefinition[]>
  probe(): Promise<ProbeResult>
}
