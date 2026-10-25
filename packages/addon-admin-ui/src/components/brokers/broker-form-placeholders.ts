/**
 * Kind-agnostic schema rewrite for BrokerForm: replace `{{brokerId}}` in
 * info-field HTML (OAuth Connect links, etc.) when editing an existing broker.
 */
import type { ConfigField, ConfigUISchema } from '../../types/config-ui'

export function substituteBrokerIdPlaceholders(
  schema: ConfigUISchema,
  brokerId: string,
): ConfigUISchema {
  const rewriteFields = (fields: readonly ConfigField[]): ConfigField[] =>
    fields.map((field) => {
      if (field.type === 'group') {
        return { ...field, fields: rewriteFields(field.fields) }
      }
      if (field.type === 'sub-tabs') {
        return {
          ...field,
          tabs: field.tabs.map((tab) => ({
            ...tab,
            fields: rewriteFields(tab.fields),
          })),
        }
      }
      if (field.type === 'info' && typeof field.content === 'string') {
        return { ...field, content: field.content.split('{{brokerId}}').join(brokerId) }
      }
      return field
    })
  return {
    ...schema,
    sections: schema.sections.map((section) => ({
      ...section,
      fields: rewriteFields(section.fields as readonly ConfigField[]),
    })),
  }
}
