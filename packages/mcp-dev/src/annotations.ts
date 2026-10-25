/**
 * MCP tool annotations (plan §3.10): every tool declares what it does to the
 * world so a client can approve by class instead of by guess.
 *
 *   - READ_LOCAL  reads the working tree only
 *   - READ_HUB    reads the hub (and, for loki_query, a Loki) — open world
 *   - WRITE_LOCAL writes inside the workspace; dry-run by default where it can
 *   - WRITE_LOCAL_DESTRUCTIVE may overwrite generated/baseline files
 *
 *   - WRITE_LOCAL_OPEN writes inside the workspace AND talks to a network (a pip
 *     install, a hub download); never mutates the cluster
 *   - MUTATES_CLUSTER changes the running cluster. Registered only with
 *     `--allow-mutations`, and only ever executed through the mutation gate
 *     (dry run, one-shot confirm_token; D836).
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

const READ_LOCAL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const READ_HUB: ToolAnnotations = { ...READ_LOCAL, openWorldHint: true }

const WRITE_LOCAL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

const WRITE_LOCAL_OPEN: ToolAnnotations = { ...WRITE_LOCAL, openWorldHint: true }

const MUTATES_CLUSTER: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

const WRITE_LOCAL_DESTRUCTIVE: ToolAnnotations = { ...WRITE_LOCAL, destructiveHint: true }

const BY_CLASS: Readonly<Record<string, readonly string[]>> = {
  READ_LOCAL: [
    'search_knowledge',
    'get_decision',
    'decisions_for_path',
    'traps_for',
    'subsystem_of',
    'subsystem_map',
    'guards_for',
    'list_skills',
    'get_skill',
    'read_section',
    'next_adr_number',
    'find_ui_component',
    'get_ui_component',
    'list_ui_tokens',
    'check_ui_file',
    'list_capabilities',
    'get_capability',
    'who_provides',
    'plan_capability',
    'cap_ship_plan',
    'list_addons',
    'get_addon',
    'list_examples',
    'find_example',
    'validate_addon',
    'affected_checks',
    'release_plan',
    'model_floors',
  ],
  READ_HUB: [
    'ops_status',
    'hub_query',
    'topology',
    'cap_providers',
    'recent_tracks',
    'track',
    'audit_tracks',
    'log_providers',
    'hub_logs',
    'loki_query',
    'model_pin_census',
    'retrain_census',
    'keyframe_presence',
    'birth_decisions',
    'event_density',
    'benchmark_status',
    'release_status',
  ],
  WRITE_LOCAL: ['scaffold_capability', 'scaffold_addon', 'scaffold_ui_component', 'run_checks'],
  WRITE_LOCAL_OPEN: ['eval_model', 'fetch_retrain_export'],
  MUTATES_CLUSTER: ['benchmark_run', 'model_studio_import'],
  WRITE_LOCAL_DESTRUCTIVE: ['run_codegen', 'method_tiers_diff', 'extend_addon'],
}

const ANNOTATION_OF_CLASS: Readonly<Record<string, ToolAnnotations>> = {
  READ_LOCAL,
  READ_HUB,
  WRITE_LOCAL,
  WRITE_LOCAL_OPEN,
  WRITE_LOCAL_DESTRUCTIVE,
  MUTATES_CLUSTER,
}

const BY_NAME: ReadonlyMap<string, ToolAnnotations> = new Map(
  Object.entries(BY_CLASS).flatMap(([cls, names]) => {
    const annotation = ANNOTATION_OF_CLASS[cls]
    if (!annotation) throw new Error(`annotation class ${cls} is not defined`)
    return names.map((name): [string, ToolAnnotations] => [name, annotation])
  }),
)

/** Every registered tool must be classified; an unclassified one is a programming error. */
export function annotationsFor(toolName: string): ToolAnnotations {
  const found = BY_NAME.get(toolName)
  if (!found)
    throw new Error(`tool "${toolName}" has no annotation class — add it to annotations.ts`)
  return found
}

export const MUTATING_TOOL_NAMES: readonly string[] = BY_CLASS['MUTATES_CLUSTER'] ?? []

export const HUB_READ_TOOL_NAMES: readonly string[] = BY_CLASS['READ_HUB'] ?? []
