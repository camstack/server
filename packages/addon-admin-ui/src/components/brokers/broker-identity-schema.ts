/**
 * The Add-broker dialog's own fields — which kind, what name, and whether to
 * restore a removed broker under its original id — as a `ConfigUISchema`, so
 * the dialog draws them with the same form builder as the kind's connection
 * settings below them instead of a hand-rolled select / input / checkbox.
 *
 * The values stay the dialog's (they are arguments of `broker.add`, not stored
 * settings), and so does the validation: a schema field has no cross-field
 * "required when" rule, and restoring with a blank id would quietly create a
 * NEW broker — the outcome the operator ticked the box to avoid.
 */
import type { ConfigField, ConfigUISchema } from '../../types/config-ui'
import i18n from '../../i18n/index'

export const IDENTITY_KIND = 'kind'
export const IDENTITY_NAME = 'name'
export const IDENTITY_RESTORE = 'restore'
export const IDENTITY_RESTORE_ID = 'restoreId'

export interface BrokerKindOption {
  /** `addonId::kind` — a kind served by two providers stays two options. */
  readonly key: string
  readonly label: string
}

export function buildBrokerIdentitySchema(
  kinds: readonly BrokerKindOption[],
  options: { readonly allowRestore: boolean } = { allowRestore: true },
): ConfigUISchema {
  const fields: ConfigField[] = []
  // A provider that serves one kind has nothing to choose between: no control.
  if (kinds.length > 1) {
    fields.push({
      type: 'select',
      key: IDENTITY_KIND,
      label: i18n.t('helpers.brokerIdentitySchema.kind'),
      options: kinds.map((k) => ({ value: k.key, label: k.label })),
    })
  }
  fields.push({
    type: 'text',
    key: IDENTITY_NAME,
    label: i18n.t('helpers.brokerIdentitySchema.name'),
    placeholder: i18n.t('helpers.brokerIdentitySchema.namePlaceholder'),
    required: true,
  })
  if (options.allowRestore) {
    fields.push(
      {
        type: 'boolean',
        key: IDENTITY_RESTORE,
        label: i18n.t('helpers.brokerIdentitySchema.restore'),
        description: i18n.t('helpers.brokerIdentitySchema.restoreHint'),
      },
      {
        type: 'text',
        key: IDENTITY_RESTORE_ID,
        label: i18n.t('helpers.brokerIdentitySchema.originalId'),
        placeholder: 'ha_004',
        required: true,
        showWhen: { field: IDENTITY_RESTORE, equals: true },
      },
    )
  }
  return {
    sections: [
      {
        id: 'broker-identity',
        title: i18n.t('helpers.brokerIdentitySchema.title'),
        columns: 1,
        fields,
      },
    ],
  }
}

export interface BrokerIdentity {
  readonly kindKey: string
  readonly name: string
  /** The id to adopt, or null for a freshly minted one. */
  readonly restoreId: string | null
}

export type BrokerIdentityResult =
  | { readonly ok: true; readonly identity: BrokerIdentity }
  | { readonly ok: false; readonly problem: string }

/** Read the dialog's values into an `add` call's identity, or say what is missing. */
export function readBrokerIdentity(
  values: Readonly<Record<string, unknown>>,
): BrokerIdentityResult {
  const text = (key: string): string => {
    const v = values[key]
    return typeof v === 'string' ? v.trim() : ''
  }
  const kindKey = text(IDENTITY_KIND)
  if (kindKey === '') return { ok: false, problem: 'Pick a kind.' }
  const name = text(IDENTITY_NAME)
  if (name === '') return { ok: false, problem: 'Enter a name before saving.' }
  if (values[IDENTITY_RESTORE] !== true)
    return { ok: true, identity: { kindKey, name, restoreId: null } }
  const restoreId = text(IDENTITY_RESTORE_ID)
  if (restoreId === '') {
    return {
      ok: false,
      problem: 'Enter the original id, or turn restore off to create a new broker.',
    }
  }
  return { ok: true, identity: { kindKey, name, restoreId } }
}
