/**
 * Training → Providers: the Modal accounts behind the instances table (`/training/providers`).
 * The training-modal addon holds two account records, one switched on and configured, one new
 * and empty. Providers come from the shell's workspace manifests. Invented data.
 */
import { defineFixtures } from './_define'

const SET = { $secret: 'ref', v: 1, set: true }

const MODAL_FORM = {
  sections: [
    {
      id: 'credentials',
      title: 'Credentials',
      columns: 2,
      fields: [
        { type: 'text', key: 'tokenId', label: 'Token id', placeholder: 'ak-…' },
        { type: 'password', key: 'tokenSecret', label: 'Token secret' },
        { type: 'text', key: 'environment', label: 'Environment' },
      ],
    },
    {
      id: 'defaults',
      title: 'Defaults',
      columns: 2,
      fields: [
        { type: 'text', key: 'gpuType', label: 'GPU', default: 'L4' },
        { type: 'number', key: 'costCapUsd', label: 'Cost cap (USD)', default: 5 },
      ],
    },
  ],
}

export default defineFixtures({
  area: 'training-providers',
  description: 'integration-instances records of the Modal training accounts',
  handlers: {
    'integrationInstances.describe': {
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
      mintsId: true,
    },
    'integrationInstances.instanceFormSchema': MODAL_FORM,
    'integrationInstances.listInstances': [
      {
        id: 'a1b2c3d4-0000-4000-8000-000000000001',
        name: 'Home account',
        configured: true,
        formValues: { tokenId: 'ak-example', tokenSecret: SET, environment: 'main', gpuType: 'L4' },
      },
      {
        id: 'a1b2c3d4-0000-4000-8000-000000000002',
        name: 'Lab',
        configured: false,
        formValues: { tokenId: '', environment: '', gpuType: 'L4' },
      },
    ],
    'mut:integrationInstances.createInstance': { id: 'a1b2c3d4-0000-4000-8000-000000000003' },
    'mut:integrationInstances.updateInstance': { ok: true },
    'mut:integrationInstances.setInstanceEnabled': { ok: true },
    'mut:integrationInstances.deleteInstance': { ok: true },
    'mut:integrationInstances.testInstance': { success: true, status: 'validated' },
  },
})
