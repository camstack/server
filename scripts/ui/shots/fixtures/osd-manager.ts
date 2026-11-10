/**
 * The OSD Manager addon page (`/addon/osd-manager`): a table of cameras with
 * their overlay slots, and the named device templates (`{{ alias.field | unit }}`)
 * those slots point at. Routes: `?device=101&panel=binding` opens a camera's
 * slot editor, `?tab=templates&edit=tpl-temperature` the template editor.
 */
import { defineFixtures } from './_define'

const CAMERAS = [
  { id: 101, name: 'Driveway' },
  { id: 102, name: 'Garden' },
]
const SENSOR_ID = 201

const TEMPLATES = [
  {
    id: 'tpl-temperature',
    name: 'Garage temperature',
    text: "{{ garage.temperature | unit('°C') | round(0) }} {% if garage.humidity > 60 %}damp{% endif %}",
  },
  {
    id: 'tpl-clock',
    name: 'Clock and visitor',
    text: "{{ now | time('HH:mm') }} {{ camera.lastPerson }}",
  },
]

const slots = (templateId: string) => [
  {
    slotId: 'text-1',
    kind: 'text',
    readOnly: false,
    cameraEnabled: true,
    cameraText: '21°C',
    binding: { enabled: true, source: { kind: 'template', templateId } },
  },
  {
    slotId: 'text-2',
    kind: 'text',
    readOnly: false,
    cameraEnabled: true,
    binding: null,
  },
  { slotId: 'time-1', kind: 'timestamp', readOnly: true, cameraEnabled: true, binding: null },
]

export default defineFixtures({
  area: 'osd-manager',
  description: 'OSD Manager addon: two cameras, two device templates, a template preview',
  handlers: {
    'deviceManager.listAll': [
      ...CAMERAS.map((c) => ({
        id: c.id,
        name: c.name,
        stableId: `demo-camera-${String(c.id)}`,
        addonId: 'demo-provider',
        disabled: false,
        type: 'camera',
        location: null,
        isCamera: true,
        alias: `camera_${String(c.id)}`,
      })),
      {
        id: SENSOR_ID,
        name: 'Garage sensor',
        stableId: 'demo-sensor-201',
        addonId: 'demo-provider',
        disabled: false,
        type: 'sensor',
        location: null,
        isCamera: false,
        alias: 'garage',
      },
    ],
    'deviceManager.getAllBindings': CAMERAS.map((c) => ({
      deviceId: c.id,
      entries: [{ capName: 'osd' }, { capName: 'streaming' }],
    })),
    'deviceManager.listSiteZones': [],
    'osdManager.getDeviceOsd': (input: { deviceId: number }) => ({
      supported: true,
      slots: slots(input.deviceId === 101 ? 'tpl-temperature' : 'tpl-clock'),
    }),
    'osdManager.listTemplates': { templates: TEMPLATES },
    'mut:osdManager.previewTemplate': {
      ok: true,
      text: '21 damp',
      notes: [],
    },
    'deviceManager.checkDeviceTemplates': {
      results: [
        {
          ok: true,
          readsClock: false,
          aliases: [{ alias: 'garage', deviceId: SENSOR_ID, allowed: true }],
        },
      ],
    },
    'deviceManager.renderDeviceTemplates': {
      results: [{ ok: true, text: '21 damp', trace: [] }],
    },
  },
})
