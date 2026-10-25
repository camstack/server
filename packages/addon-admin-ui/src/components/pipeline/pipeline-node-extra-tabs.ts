/**
 * Extra tabs on Pipeline → Nodo.
 *
 * Models are not here: catalog, download, availability and distribution
 * live in Model Studio (including the node picker).
 */
export const PIPELINE_NODE_EXTRA_TAB_IDS = ['assignments', 'tree', 'engines', 'logs'] as const

export type PipelineNodeExtraTabId = (typeof PIPELINE_NODE_EXTRA_TAB_IDS)[number]
