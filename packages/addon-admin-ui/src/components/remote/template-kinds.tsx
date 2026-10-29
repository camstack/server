/**
 * What the Templates page knows of each template kind (D964): its name, an
 * empty payload, a one-line summary and the editor of its payload. The kinds
 * come from the system (`TEMPLATE_KINDS`); this table is exhaustive over them,
 * so the compiler refuses a kind the page cannot edit. The store itself is
 * generic — only this table is kind-specific on the admin side.
 */
import { checkTemplatePayload, TEMPLATE_KINDS, type TemplateKind } from '@camstack/types'
import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import { checkedLayout, emptyLayout, layoutOf } from './layout-model'
import { copyOfPreset, REMOTE_LAYOUT_PRESETS } from './layout-presets'
import { RemoteLayoutEditor } from './RemoteLayoutEditor'

export interface TemplateKindView {
  readonly label: (t: TFunction) => string
  readonly emptyPayload: () => unknown
  readonly summary: (payload: unknown, t: TFunction) => string
  readonly renderEditor: (payload: unknown, onChange: (next: unknown) => void) => ReactNode
  /** Whether the payload is one the store will accept. */
  readonly isSavable: (payload: unknown) => boolean
  /** Built-in, read-only starting points; choosing one yields an editable copy. */
  readonly presets: (t: TFunction) => readonly TemplatePresetChoice[]
}

export interface TemplatePresetChoice {
  readonly id: string
  readonly label: string
  /** A fresh copy of the preset's payload on every call. */
  readonly payload: () => unknown
}

const VIEWS: Readonly<Record<TemplateKind, TemplateKindView>> = {
  remote: {
    label: (t) => t('remote.templates.kind.remote'),
    emptyPayload: emptyLayout,
    summary: (payload, t) => {
      const grid = layoutOf(payload)
      return t('remote.templates.layoutSummary', {
        columns: grid.columns,
        rows: grid.rows,
        count: grid.buttons.length,
      })
    },
    renderEditor: (payload, onChange) => (
      <RemoteLayoutEditor value={layoutOf(payload)} onChange={onChange} />
    ),
    isSavable: (payload) => checkedLayout(layoutOf(payload)) !== null,
    presets: (t) =>
      REMOTE_LAYOUT_PRESETS.map((preset) => ({
        id: preset.id,
        label: t(`remote.templates.preset.${preset.id}`),
        payload: () => copyOfPreset(preset.id),
      })),
  },
}

export function templateKindView(kind: TemplateKind): TemplateKindView {
  return VIEWS[kind]
}

/** The kinds the Templates page offers when creating one. */
export const CREATABLE_TEMPLATE_KINDS: readonly TemplateKind[] = TEMPLATE_KINDS

/** The payload as the store will keep it, or null when the kind's schema refuses it. */
export function savablePayload(kind: TemplateKind, payload: unknown): unknown {
  const checked = checkTemplatePayload(kind, payload)
  return checked.ok ? checked.payload : null
}
