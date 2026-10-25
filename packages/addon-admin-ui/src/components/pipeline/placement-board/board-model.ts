/**
 * board-model — pure types + settings-schema readers for the pipeline
 * placement board.
 *
 * Kept framework-free (no React, no hooks) so the read helpers stay unit
 * testable and the card/table subcomponents share one source of truth for
 * the row shape + capability metadata.
 */
import type { QueryClient } from '@tanstack/react-query'
import type { ConcernEnablement } from '../lib/node-enablement'
import i18n from '../../../i18n/index'

export const ORCHESTRATOR_ADDON_ID = 'pipeline-orchestrator'
// The recording node is owned by the `recorder` addon (single source of truth),
// NOT the orchestrator. The "Recording" picker reads/writes the recorder's
// canonical `recordingNodeId` global setting directly — it is a utility view
// over that value, not an independent orchestrator role.
export const RECORDER_ADDON_ID = 'recorder'
export const RECORDING_NODE_KEY = 'recordingNodeId'
export const ANALYTICS_ADDON_ID = 'pipeline-analytics'
export const POST_PROCESSING_NODE_KEY = 'postProcessingNodeId'

export const ROLE_FIELDS = [
  'ingestNode',
  'recordingNode',
  'audioNode',
  'motionNode',
  'postProcessingNode',
] as const
// Per-node distributed capabilities: detect (pipeline) and audio sessions.
// `ingest` remains a cluster-wide singleton role (ingestNode picker). `decode`
// is no longer a knob — decode is co-located with detect.
export const CAPABILITY_FIELDS = ['detect', 'audio'] as const

export type RoleField = (typeof ROLE_FIELDS)[number]
export type CapabilityKey = (typeof CAPABILITY_FIELDS)[number]

/** Static per-capability presentation metadata shared by card + table cells. */
export interface CapabilityMeta {
  readonly key: CapabilityKey
  /** i18n keys, resolved by the consumer. */
  readonly labelKey: string
  readonly hintKey: string
}

export const CAPABILITY_META: readonly CapabilityMeta[] = [
  {
    key: 'detect',
    labelKey: 'placementBoard.boardModel.detectLabel',
    hintKey: 'placementBoard.boardModel.detectHint',
  },
  {
    key: 'audio',
    labelKey: 'placementBoard.boardModel.audioLabel',
    hintKey: 'placementBoard.boardModel.audioHint',
  },
]

export interface BoardNode {
  readonly id: string
  readonly name: string
  readonly isHub: boolean
  readonly isOnline: boolean
  readonly settings: object | undefined
  readonly effective: ConcernEnablement
}

/** Per-node save status for an inline settings editor backed by one shared
 *  mutation instance (scoped by comparing against the mutation's last
 *  `variables.agentNodeId`). */
export type ReachableHostSaveStatus = 'idle' | 'pending' | 'success' | 'error'

/** Shared cell-action surface wired once by the Roles & nodes tab. Decode
 *  limits are pipeline-runner `perNode` fields on Engine & decoder (D365).
 *  Shares and caps are on the Load balancing tab (D748). */
export interface PlacementActions {
  readonly capabilityPending: boolean
  readonly onToggleCapability: (nodeId: string, capability: CapabilityKey, enabled: boolean) => void
}

interface SchemaField {
  readonly key?: string
  readonly value?: unknown
}

interface SchemaSection {
  readonly fields?: readonly SchemaField[]
}

export interface SettingsSchemaLike {
  readonly sections?: readonly SchemaSection[]
}

export function readField(schema: SettingsSchemaLike | null | undefined, key: string): unknown {
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields ?? []) {
      if (field.key === key) return field.value
    }
  }
  return undefined
}

export function readObjectField(settings: object | null | undefined, key: string): unknown {
  for (const [entryKey, value] of Object.entries(settings ?? {})) {
    if (entryKey === key) return value
  }
  return undefined
}

export function readStringField(
  schema: SettingsSchemaLike | null | undefined,
  key: string,
  fallback: string,
): string {
  const value = readField(schema, key)
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

export function readNumberObjectField(
  settings: object | null | undefined,
  key: string,
): number | null {
  const value = readObjectField(settings, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readStringObjectField(
  settings: object | null | undefined,
  key: string,
): string | null {
  const value = readObjectField(settings, key)
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function roleLabel(role: RoleField): string {
  if (role === 'ingestNode') return i18n.t('placementBoard.boardModel.roleIngest')
  if (role === 'recordingNode') return i18n.t('placementBoard.boardModel.roleRecording')
  if (role === 'audioNode') return i18n.t('placementBoard.boardModel.roleAudio')
  if (role === 'postProcessingNode') return i18n.t('placementBoard.boardModel.rolePostProcessing')
  return i18n.t('placementBoard.boardModel.roleMotion')
}

export function roleHint(role: RoleField): string {
  if (role === 'ingestNode') return i18n.t('placementBoard.boardModel.hintIngest')
  if (role === 'recordingNode') return i18n.t('placementBoard.boardModel.hintRecording')
  if (role === 'audioNode') return i18n.t('placementBoard.boardModel.hintAudio')
  if (role === 'postProcessingNode') return i18n.t('placementBoard.boardModel.hintPostProcessing')
  return i18n.t('placementBoard.boardModel.hintMotion')
}

export function capabilityValue(effective: ConcernEnablement, capability: CapabilityKey): boolean {
  switch (capability) {
    case 'detect':
      return effective.pipeline
    case 'audio':
      return effective.audio
  }
}

/** Narrow an unknown mutation error (tRPC client error, plain `Error`, or
 *  anything else) to a display-safe message. */
export function mutationErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return i18n.t('placementBoard.boardModel.saveFailed')
}

export function invalidatePlacementQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [['pipelineOrchestrator', 'listAgentSettings']] })
  void queryClient.invalidateQueries({ queryKey: [['pipelineOrchestrator', 'getAgentSettings']] })
  void queryClient.invalidateQueries({ queryKey: [['addonSettings', 'getGlobalSettings']] })
}
