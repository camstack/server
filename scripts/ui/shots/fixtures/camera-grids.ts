/**
 * System -> Camera grids (`/system/camera-grids`): the grids as instances of the function cap
 * `camera-grid-layout`, held by the builtin `camera-grid` addon. Invented data.
 */
import { defineFixtures } from './_define'

const GRID_FORM = {
  sections: [
    {
      id: 'grid',
      title: 'Grid',
      columns: 2,
      fields: [
        { type: 'number', key: 'fps', label: 'Frame rate', default: 10 },
        {
          type: 'tags',
          key: 'publishedProfiles',
          label: 'Published profiles',
          default: ['mid', 'low'],
        },
      ],
    },
  ],
}

const grid = (id: string, name: string, enabled: boolean, cells: number) => ({
  id,
  name,
  kind: 'camera-grid',
  configured: cells > 0,
  enabled,
  formValues: { name, enabled, fps: 10, publishedProfiles: ['mid', 'low'] },
})

export default defineFixtures({
  area: 'camera-grids',
  description: 'camera grids as camera-grid-layout instances',
  handlers: {
    'addons.listCapabilityProviders': (i: { capName: string }) =>
      i.capName === 'camera-grid-layout' || i.capName === 'integration-instances'
        ? [{ addonId: 'camera-grid', capName: i.capName, isActive: true }]
        : [],
    'capabilities.getCapability': (i: { name: string }) => ({
      name: i.name,
      mode: 'singleton',
      providers: i.name === 'camera-grid-layout' ? ['camera-grid'] : [i.name],
      activeProvider: i.name === 'camera-grid-layout' ? 'camera-grid' : i.name,
      disabledProviders: [],
    }),
    'integrationInstances.describe': (i: { addonId: string }) =>
      i.addonId === 'camera-grid'
        ? {
            role: 'services',
            instanceMode: 'multiple',
            kind: 'grid',
            canTest: false,
            mintsId: true,
            kinds: [{ id: 'camera-grid', label: 'Camera grid', functionCap: 'camera-grid-layout' }],
          }
        : { role: 'services', instanceMode: 'multiple', kind: 'other', canTest: false, kinds: [] },
    'integrationInstances.instanceFormSchema': () => GRID_FORM,
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      i.addonId === 'camera-grid'
        ? [
            grid('5d1f0a52-7c3e-4b8a-9e21-0a1b2c3d4e01', 'Front 2x2', true, 4),
            grid('5d1f0a52-7c3e-4b8a-9e21-0a1b2c3d4e02', 'Garden', false, 2),
            grid('5d1f0a52-7c3e-4b8a-9e21-0a1b2c3d4e03', 'Empty draft', true, 0),
          ]
        : [],
    'mut:integrationInstances.createInstance': (i: { id: string }) => ({ id: i.id }),
    'mut:integrationInstances.updateInstance': { ok: true },
    'mut:integrationInstances.setInstanceEnabled': { ok: true },
    'mut:integrationInstances.deleteInstance': { ok: true },
  },
})
