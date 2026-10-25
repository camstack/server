/**
 * Custom field renderer registry.
 *
 * The ui-library's `config-form-field.tsx` switch handles built-in field
 * types (text, number, select, …). Field types declared in
 * `@camstack/types/interfaces/config-ui` that need heavy host-app
 * components (e.g. `zone-editor` → polygon canvas via konva) are
 * dispatched through this registry: a host app (admin-ui) wraps the
 * device-detail tree with `CustomFieldRenderersProvider`, supplying a
 * map of `field.type → React component`. The form renderer looks up
 * the type at the `default:` branch and renders the registered
 * component instead of returning `null`.
 *
 * Why a registry instead of static imports:
 *   1. ui-library stays free of heavy deps (konva, etc.) — host apps
 *      that don't render the device page never pay the cost.
 *   2. New custom field types can be added by addon code without
 *      modifying ui-library.
 *   3. The renderer can read host-only context (e.g. tRPC client,
 *      device id) directly, instead of threading props through the
 *      form's recursion.
 *
 * Usage (host app, e.g. admin-ui App.tsx):
 *
 *   <CustomFieldRenderersProvider renderers={{
 *     'zone-editor': (props) => <DeviceZonesPanel field={props.field} />,
 *   }}>
 *     <Routes>...</Routes>
 *   </CustomFieldRenderersProvider>
 *
 * The renderer receives the same props shape as built-in cases:
 *   - `field`: the discriminated-union ConfigField (already narrowed by
 *     the renderer's contract — but TypeScript can't see through the
 *     dynamic dispatch, so the implementation must validate / cast).
 *   - `value`, `onChange`, `disabled` — same as built-in fields.
 */
import { useContext, type ComponentType, type ReactNode, type JSX } from 'react'
import type { ConfigField } from '@camstack/types'
import { createSharedContext } from '../lib/shared-context'

/**
 * Props shape every custom renderer receives. Keep it congruent with
 * the built-in `case` branches so the dispatcher in `config-form-field`
 * can pass arguments uniformly.
 */
export interface CustomFieldRendererProps {
  readonly field: ConfigField
  readonly value: unknown
  readonly onChange: (value: unknown) => void
  readonly disabled?: boolean
}

export type CustomFieldRenderer = ComponentType<CustomFieldRendererProps>

export type CustomFieldRendererMap = Readonly<Record<string, CustomFieldRenderer>>

const CustomFieldRenderersContext = createSharedContext<CustomFieldRendererMap>(
  'camstack:custom-field-renderers',
  {},
)

export interface CustomFieldRenderersProviderProps {
  readonly renderers: CustomFieldRendererMap
  readonly children: ReactNode
}

export function CustomFieldRenderersProvider({
  renderers,
  children,
}: CustomFieldRenderersProviderProps): JSX.Element {
  return (
    <CustomFieldRenderersContext.Provider value={renderers}>
      {children}
    </CustomFieldRenderersContext.Provider>
  )
}

/**
 * Look up a registered renderer by `field.type`. Returns null when no
 * renderer is registered — caller falls back to its built-in handling
 * (or renders nothing).
 */
export function useCustomFieldRenderer(type: string): CustomFieldRenderer | null {
  const map = useContext(CustomFieldRenderersContext)
  return map[type] ?? null
}
