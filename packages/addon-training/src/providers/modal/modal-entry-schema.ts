/**
 * Modal entry form schema — same shape NC uses for `kind.configSchema`
 * (`ConfigFormBuilder` + `type: 'password'`). Storage stays keychain (D787)
 * via `secretStatePaths`; this schema only drives the Providers dialog.
 */
import type { ConfigUISchema } from '@camstack/types'
import { MODAL_DEFAULT_GPU, MODAL_GPUS, MODAL_REGIONS } from './modal-pricing.js'

export const MODAL_ENTRY_CONFIG_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'credentials',
      title: 'Credentials',
      columns: 2,
      fields: [
        {
          type: 'text',
          key: 'tokenId',
          label: 'Token id',
          placeholder: 'ak-…',
        },
        {
          type: 'password',
          key: 'tokenSecret',
          label: 'Token secret',
          placeholder: 'as-…',
          showToggle: true,
        },
        {
          type: 'text',
          key: 'environment',
          label: 'Environment',
          placeholder: 'Optional workspace environment',
        },
      ],
    },
    {
      id: 'defaults',
      title: 'Defaults',
      columns: 2,
      fields: [
        {
          type: 'select',
          key: 'gpuType',
          label: 'GPU',
          default: MODAL_DEFAULT_GPU,
          options: MODAL_GPUS.map((g) => ({ value: g.id, label: g.label })),
        },
        {
          type: 'select',
          key: 'region',
          label: 'Region',
          default: '',
          options: MODAL_REGIONS.map((r) => ({ value: r.id, label: r.label })),
        },
        {
          type: 'number',
          key: 'costCapUsd',
          label: 'Cost cap (USD)',
          default: 5,
          min: 0,
          step: 0.5,
        },
        {
          type: 'number',
          key: 'maxRuntimeHours',
          label: 'Max runtime (hours)',
          default: 4,
          min: 0.1,
          step: 0.5,
        },
        {
          type: 'number',
          key: 'failedDatasetGraceHours',
          label: 'Failed-job dataset grace (hours)',
          default: 24,
          min: 0,
          step: 1,
        },
      ],
    },
  ],
}

/** Empty create values (password absent → plain PasswordField via KeychainOr). */
export const MODAL_ENTRY_CREATE_VALUES: Record<string, unknown> = {
  tokenId: '',
  tokenSecret: '',
  environment: '',
  gpuType: MODAL_DEFAULT_GPU,
  region: '',
  costCapUsd: 5,
  maxRuntimeHours: 4,
  failedDatasetGraceHours: 24,
}
