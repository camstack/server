/**
 * node-enablement — resolves effective per-node pipeline capabilities.
 *
 * The placement-model redesign moved node enablement out of orchestrator
 * global flat lists and into the per-node agent-settings records returned by
 * `pipelineOrchestrator.listAgentSettings()`. Capability flags are sparse:
 * an unset flag inherits the orchestrator default (hub=true, non-hub=false).
 */

export interface ConcernEnablement {
  readonly pipeline: boolean
  readonly audio: boolean
  readonly ingest: boolean
}

export interface AgentSettingsRow {
  readonly nodeId: string
  readonly settings: object
}

function defaultCapability(isHub: boolean): boolean {
  return isHub
}

function objectField(settings: object | null | undefined, key: string): unknown {
  for (const [entryKey, value] of Object.entries(settings ?? {})) {
    if (entryKey === key) return value
  }
  return undefined
}

function effectiveFlag(value: unknown, isHub: boolean): boolean {
  if (typeof value === 'boolean') return value
  return defaultCapability(isHub)
}

export function effectiveCapabilitySettings(
  settings: object | null | undefined,
  isHub: boolean,
): ConcernEnablement {
  // NOTE: there is deliberately NO `decode` concern — decode is always
  // co-located with its frame consumer (detect ⇒ decode), so the legacy
  // per-node decode flag is ignored everywhere.
  return {
    pipeline: effectiveFlag(objectField(settings, 'detect'), isHub),
    audio: effectiveFlag(objectField(settings, 'audio'), isHub),
    ingest: effectiveFlag(objectField(settings, 'ingest'), isHub),
  }
}

export function concernEnablement(
  rows: readonly AgentSettingsRow[] | null | undefined,
  nodeId: string,
  isHub: boolean,
): ConcernEnablement {
  const row = rows?.find((entry) => entry.nodeId === nodeId)
  return effectiveCapabilitySettings(row?.settings, isHub)
}
