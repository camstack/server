/**
 * `storage/path-browser` — the folder of a node-local storage location, picked by browsing the
 * node's own disk (`PathBrowser`). It applies only while the draft provider is node-local, which
 * the form schema says: the Node field exists, and on create it is shown for that provider alone.
 * The path lives under the provider's own key (`basePath`; `<provider>.basePath` on create).
 */
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConfigUISchema } from '../../types/config-ui'
import type { KindWidgetProps } from '../instances/kind-widgets'
import { PathBrowser } from './PathBrowser'

export const STORAGE_PATH_WIDGET_ID = 'storage/path-browser'

const NODE_KEY = 'nodeId'
const PROVIDER_KEY = 'providerId'
const PATH_KEY = 'basePath'
const HUB_NODE = 'hub'

function textOf(values: Readonly<Record<string, unknown>>, key: string): string {
  const value = values[key]
  return typeof value === 'string' ? value : ''
}

/** The form key of the path for the draft provider, or null when this widget does not apply. */
function pathKeyOf(
  schema: ConfigUISchema,
  values: Readonly<Record<string, unknown>>,
): string | null {
  const fields = schema.sections.flatMap((section) => section.fields)
  const nodeField = fields.find((field) => field.key === NODE_KEY)
  if (nodeField === undefined) return null
  const providerId = textOf(values, PROVIDER_KEY)
  const gate = 'showWhen' in nodeField ? nodeField.showWhen : undefined
  if (gate !== undefined && !(providerId !== '' && gate.in?.includes(providerId))) return null
  const candidates = providerId === '' ? [PATH_KEY] : [`${providerId}.${PATH_KEY}`, PATH_KEY]
  return candidates.find((key) => fields.some((field) => field.key === key)) ?? null
}

export function storagePathOwnedKeys(
  schema: ConfigUISchema,
  values: Readonly<Record<string, unknown>>,
): readonly string[] {
  const key = pathKeyOf(schema, values)
  return key === null ? [] : [key]
}

export function StoragePathWidget({
  schema,
  values,
  onValuesChange,
}: KindWidgetProps): ReactElement | null {
  const { t } = useTranslation()
  const key = pathKeyOf(schema, values)
  if (key === null) return null
  const node = textOf(values, NODE_KEY)
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground-muted">
        {t('storage.pathBrowser.label', 'Folder on the node')}
      </p>
      <PathBrowser
        nodeId={node === '' ? HUB_NODE : node}
        value={textOf(values, key)}
        onChange={(path) => onValuesChange({ ...values, [key]: path })}
      />
    </div>
  )
}
