import type { ConfigFieldWithValue, ConfigUISchemaWithValues } from '@camstack/types'

/** Walk a hydrated field and everything nested in it (`group`, `sub-tabs`). */
function visit(field: ConfigFieldWithValue, out: Record<string, unknown>): void {
  if (field.type === 'group') {
    for (const child of field.fields) visit(child, out)
    return
  }
  if (field.type === 'sub-tabs') {
    for (const tab of field.tabs) for (const child of tab.fields) visit(child, out)
    return
  }
  if ('value' in field) out[field.key] = field.value
}

/** The flat key -> value map of a hydrated schema; fields without a value contribute nothing. */
export function flatFormValues(schema: ConfigUISchemaWithValues): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const section of schema.sections) for (const field of section.fields) visit(field, out)
  return out
}
