/**
 * Connectivity → Calendars: the waste-collections sources as `integration-instances` records
 * beside a configured and an unconfigured municipal service. Invented data.
 */
import { defineFixtures } from './_define'

const WASTE_FORM = {
  sections: [
    {
      id: 'service',
      title: 'Service',
      columns: 2,
      fields: [
        { type: 'text', key: 'street', label: 'Street', default: '' },
        { type: 'text', key: 'house_number', label: 'House number', default: '' },
        { type: 'password', key: 'api_key', label: 'API key' },
      ],
    },
  ],
}

const SET = { $secret: 'ref', v: 1, set: true }

export default defineFixtures({
  area: 'waste-sources',
  description: 'waste-collections sources listed as calendar-source instances',
  handlers: {
    'integrationInstances.describe': () => ({
      instanceMode: 'multiple',
      kind: 'source',
      canTest: true,
    }),
    'integrationInstances.instanceFormSchema': () => WASTE_FORM,
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      i.addonId === 'waste-collections'
        ? [
            {
              id: 'home',
              name: 'Home',
              configured: true,
              status: { state: 'ok', detail: '12 collections' },
              formValues: { street: 'Example Street', house_number: '1', api_key: SET },
            },
            {
              id: 'cabin',
              name: 'Cabin',
              configured: false,
              formValues: { street: '', house_number: '' },
            },
          ]
        : [],
    'mut:integrationInstances.createInstance': (i: { id: string }) => ({ id: i.id }),
    'mut:integrationInstances.updateInstance': { ok: true },
    'mut:integrationInstances.setInstanceEnabled': { ok: true },
    'mut:integrationInstances.deleteInstance': { ok: true },
    'mut:integrationInstances.testInstance': { success: true, status: 'validated' },
  },
})
