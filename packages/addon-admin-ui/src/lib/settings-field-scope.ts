/**
 * Narrow a hydrated settings schema to the fields whose STORE SCOPE matches
 * the surface rendering them.
 *
 * WHY THIS EXISTS. `perNode: true` is the only thing that makes a setting
 * per-node: it scopes the persisted key to `<key>@<nodeId>`
 * (`ConfigFieldBase.perNode`, `addon/per-node-store.ts`). Without the flag the
 * value is one blob for the whole cluster, and the `nodeId` argument the UI
 * passes is discarded by `BaseAddon.updateGlobalSettings`.
 *
 * A settings surface therefore has exactly one honest population:
 *
 *   - a surface drawn under a NODE's name may show `perNode` fields only —
 *     anything else is a cluster value wearing that node's heading, and a Save
 *     there reconfigures every other node;
 *   - a surface with NO node (an addon card, the System page) may show
 *     cluster fields only — a `perNode` field there has to invent a node, and
 *     whichever it invents is a silent wrong answer for the operator who
 *     opened it thinking of a different one.
 *
 * The alternative — leave both surfaces rendering everything — is the failure
 * this repo has already shipped twice: two reachable controls, the same label,
 * different targets, and both showing a value.
 */
import type {
  ConfigFieldWithValue,
  ConfigSectionWithValues,
  ConfigUISchemaWithValues,
} from '@camstack/types'

/**
 * Which population a surface is entitled to render.
 * - `perNode`: only fields whose store key is scoped to a node.
 * - `cluster`: only fields stored once for the whole cluster.
 */
export type SettingsFieldScope = 'perNode' | 'cluster'

/**
 * `perNode` is optional on `ConfigFieldBase`, and several members of the
 * hydrated union (separator, info, button, widget…) do not extend it at all —
 * the `in` narrowing is how `BaseAddon.collectPerNodeKeys` reads it too, and
 * it keeps this free of casts.
 */
function isPerNodeField(field: ConfigFieldWithValue): boolean {
  return 'perNode' in field && field.perNode === true
}

/**
 * Keep a field if its own scope matches, or — for the layout containers
 * (`group`, `sub-tabs`) — if anything inside it survives. A container is
 * rewritten to hold only the survivors, never left claiming children it no
 * longer renders.
 */
function filterField(
  field: ConfigFieldWithValue,
  scope: SettingsFieldScope,
): ConfigFieldWithValue | null {
  if (field.type === 'group') {
    const fields = filterFields(field.fields, scope)
    return fields.length > 0 ? { ...field, fields } : null
  }
  if (field.type === 'sub-tabs') {
    const tabs = field.tabs
      .map((tab) => ({ ...tab, fields: filterFields(tab.fields, scope) }))
      .filter((tab) => tab.fields.length > 0)
    return tabs.length > 0 ? { ...field, tabs } : null
  }
  // Structural chrome (separator / info / button / widget) declares no
  // `perNode`, so it belongs to the cluster surface. Under `perNode` it is
  // dropped with everything else that is not node-scoped — a banner explaining
  // cluster settings has no business on a node's page.
  const keep = isPerNodeField(field) === (scope === 'perNode')
  return keep ? field : null
}

function filterFields(
  fields: readonly ConfigFieldWithValue[],
  scope: SettingsFieldScope,
): ConfigFieldWithValue[] {
  const out: ConfigFieldWithValue[] = []
  for (const field of fields) {
    const kept = filterField(field, scope)
    if (kept !== null) out.push(kept)
  }
  return out
}

/**
 * Apply {@link SettingsFieldScope} to a whole hydrated schema. Sections left
 * with no field are dropped — a section header over nothing reads as "this
 * addon has a setting here and it failed to load".
 */
export function filterSchemaByFieldScope(
  schema: ConfigUISchemaWithValues,
  scope: SettingsFieldScope,
): ConfigUISchemaWithValues {
  const sections: ConfigSectionWithValues[] = []
  for (const section of schema.sections) {
    const fields = filterFields(section.fields, scope)
    if (fields.length === 0) continue
    sections.push({ ...section, fields })
  }
  return { ...schema, sections }
}
