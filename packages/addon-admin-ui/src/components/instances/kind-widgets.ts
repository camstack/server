/**
 * Parts of an instance dialog the flat form cannot draw, by GENERIC widget id (the `widgets` a kind
 * declares, placement `connection`). The dialog looks the id up HERE and never branches on a kind;
 * an id this build does not know draws nothing, so the plain form stays usable.
 *
 * A widget reads and replaces the draft values. `ownedKeys` names the form fields it draws
 * itself, so the dialog does not show them twice; it returns none when the widget does not apply
 * to the draft (another provider), and then the plain fields stay.
 */
import type { ComponentType } from 'react'
import type { ConfigUISchema } from '../../types/config-ui'
import {
  STORAGE_PATH_WIDGET_ID,
  StoragePathWidget,
  storagePathOwnedKeys,
} from '../storage/StoragePathWidget'

export interface KindWidgetProps {
  readonly schema: ConfigUISchema
  readonly values: Record<string, unknown>
  readonly onValuesChange: (next: Record<string, unknown>) => void
}

export interface KindWidget {
  readonly Component: ComponentType<KindWidgetProps>
  readonly ownedKeys: (
    schema: ConfigUISchema,
    values: Readonly<Record<string, unknown>>,
  ) => readonly string[]
}

const KIND_WIDGETS: ReadonlyMap<string, KindWidget> = new Map<string, KindWidget>([
  [STORAGE_PATH_WIDGET_ID, { Component: StoragePathWidget, ownedKeys: storagePathOwnedKeys }],
])

/** `null` = this build ships no widget with that id. */
export function kindWidget(id: string): KindWidget | null {
  return KIND_WIDGETS.get(id) ?? null
}

/** The schema without the fields a widget draws itself. */
export function withoutFields<
  S extends {
    readonly sections: readonly { readonly fields: readonly { readonly key: string }[] }[]
  },
>(schema: S, keys: readonly string[]): S {
  if (keys.length === 0) return schema
  return {
    ...schema,
    sections: schema.sections.map((section) => ({
      ...section,
      fields: section.fields.filter((field) => !keys.includes(field.key)),
    })),
  }
}
