/**
 * node-enablement — resolves effective per-node pipeline capabilities.
 *
 * The placement-model redesign moved node enablement out of orchestrator
 * global flat lists and into the per-node agent-settings records returned by
 * `pipelineOrchestrator.listAgentSettings()`. Capability flags are sparse:
 * an unset flag is ON for every node (only an explicit `false` turns a role
 * off), matching the orchestrator.
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

function objectField(settings: object | null | undefined, key: string): unknown {
  for (const [entryKey, value] of Object.entries(settings ?? {})) {
    if (entryKey === key) return value
  }
  return undefined
}

function effectiveFlag(value: unknown): boolean {
  return value !== false
}

export function effectiveCapabilitySettings(
  settings: object | null | undefined,
): ConcernEnablement {
  // NOTE: there is deliberately NO `decode` concern — decode is always
  // co-located with its frame consumer (detect ⇒ decode), so the legacy
  // per-node decode flag is ignored everywhere.
  return {
    pipeline: effectiveFlag(objectField(settings, 'detect')),
    audio: effectiveFlag(objectField(settings, 'audio')),
    ingest: effectiveFlag(objectField(settings, 'ingest')),
  }
}

export function concernEnablement(
  rows: readonly AgentSettingsRow[] | null | undefined,
  nodeId: string,
): ConcernEnablement {
  const row = rows?.find((entry) => entry.nodeId === nodeId)
  return effectiveCapabilitySettings(row?.settings)
}
