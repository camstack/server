/**
 * Camera blocks in Build-your-self (planning#580). `/build/compositions/blk-grid`
 * is a camera grid: its block lays out two cameras on the grid camera 4600.
 * `/build/compositions/blk-terminal-cam` is a Terminal camera showing BTM Hub;
 * Top garage-nuc is shown by another block, so the picker names that block.
 * `/build/compositions/blk-crop` is a crop camera of Driveway. Invented data.
 */
import { defineFixtures } from './_define'
import { NOW } from './_time'

const T_HUB = '3f6c1c1e-0a51-4d0e-9a52-1d1b6f2a0001'
const T_GARAGE = '3f6c1c1e-0a51-4d0e-9a52-1d1b6f2a0002'
const T_OFFICE = '3f6c1c1e-0a51-4d0e-9a52-1d1b6f2a0003'

const block = (id: string, name: string, helper: unknown) => ({
  id,
  name,
  code: '',
  enabled: true,
  placement: 'hub',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  createdBy: 'admin',
  status: 'running',
  lastChangedAt: NOW - 3_600_000,
  source: {
    kind: 'composition',
    composition: {
      target: { kind: 'new', type: 'camera' },
      features: [],
      helper,
    },
  },
})

const GRID_BLOCK = block('blk-grid', 'Driveway wall', {
  kind: 'grid',
  fps: 10,
  publishedProfiles: ['mid', 'low'],
  cells: [],
})
const HUB_CAM = block('blk-terminal-cam', 'Hub monitor', {
  kind: 'terminal',
  terminalId: T_HUB,
})
const GARAGE_CAM = block('blk-garage-cam', 'Garage screen', {
  kind: 'terminal',
  terminalId: T_GARAGE,
})

const CROP_BLOCK = block('blk-crop', 'Driveway crop', {
  kind: 'crop',
  source: { addonId: 'provider-onvif', stableId: 'cam-4101' },
  rect: { x: 0.18, y: 0.22, width: 0.45, height: 0.253125 },
  aspect: '16:9',
  fps: 10,
  publishedProfiles: ['mid', 'low'],
})

const DEVICE_OF: Readonly<Record<string, number>> = {
  'blk-grid': 4600,
  'blk-terminal-cam': 4601,
  'blk-garage-cam': 4602,
  'blk-crop': 4603,
}

const answered = (b: { readonly id: string }) => ({
  kind: 'answered',
  state: {
    blockId: b.id,
    deviceId: DEVICE_OF[b.id] ?? null,
    status: 'running',
    fields: [],
  },
})

const camera = (id: number, name: string) => ({
  id,
  stableId: `cam-${id}`,
  addonId: 'provider-onvif',
  type: 'camera',
  name,
  location: null,
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: true,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const terminal = (id: string, name: string) => ({
  id,
  name,
  kind: 'terminals',
  configured: true,
  enabled: true,
  formValues: { name, enabled: true, nodeId: 'hub', profileId: 'monitor' },
})

export default defineFixtures({
  area: 'camera-blocks',
  description: 'a camera grid block and a Terminal camera block, one Terminal already taken',
  handlers: {
    'coreBlocks.getComposition': (input: { blockId?: string }) => {
      const found = [GRID_BLOCK, HUB_CAM, GARAGE_CAM, CROP_BLOCK].find(
        (b) => b.id === input.blockId,
      )
      return {
        state: 'loaded',
        view: found === undefined ? null : { block: found, state: answered(found) },
      }
    },
    'coreBlocks.listCompositions': {
      state: 'loaded',
      views: [GRID_BLOCK, HUB_CAM, GARAGE_CAM, CROP_BLOCK].map((b) => ({
        block: b,
        state: answered(b),
      })),
    },
    'deviceManager.listAll': [
      camera(4101, 'Driveway'),
      camera(4102, 'Front gate'),
      camera(4103, 'Garden'),
    ],
    'deviceManager.getBindings': (input: { deviceId?: number }) => ({
      deviceId: input.deviceId ?? 0,
      entries:
        input.deviceId === 4600
          ? [
              {
                capName: 'camera-grid-layout',
                kind: 'native',
                providerAddonId: 'camera-grid',
                providerNodeId: 'hub',
                nativeAddonId: 'camera-grid',
              },
            ]
          : [],
    }),
    'cameraGridLayout.getLayout': {
      blockId: 'blk-grid',
      deviceId: 4600,
      name: 'Driveway wall',
      fps: 10,
      cells: [
        {
          deviceId: 4101,
          source: { x: 0, y: 0, width: 1, height: 1 },
          cell: { x: 0, y: 0, width: 0.5, height: 1 },
        },
        {
          deviceId: 4102,
          source: { x: 0, y: 0, width: 1, height: 1 },
          cell: { x: 0.5, y: 0, width: 0.5, height: 1 },
        },
      ],
      profiles: [
        {
          profile: 'mid',
          offered: true,
          missingSources: [],
          canvas: '1280x360',
          published: true,
        },
        {
          profile: 'low',
          offered: true,
          missingSources: [],
          canvas: '640x180',
          published: true,
        },
      ],
    },
    'addons.listCapabilityProviders': (i: { capName: string }) =>
      i.capName === 'terminal-session' || i.capName === 'integration-instances'
        ? [{ addonId: 'terminal', capName: i.capName, isActive: true }]
        : [],
    'integrationInstances.describe': {
      role: 'services',
      instanceMode: 'multiple',
      kind: 'terminal',
      canTest: false,
      mintsId: true,
      kinds: [{ id: 'terminals', label: 'Terminal', functionCap: 'terminal-session' }],
    },
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      i.addonId === 'terminal'
        ? [
            terminal(T_HUB, 'BTM Hub'),
            terminal(T_GARAGE, 'Top garage-nuc'),
            terminal(T_OFFICE, 'BTM office'),
          ]
        : [],
    // The create picker (`/build/compositions/new`) reads these before it draws its tiles.
    'schedulers.list': [],
    'template.list': [],
    'actions.list': [],
    'coreBlocks.list': { blocks: [] },
    'deviceManager.listPersistedByAddon': [],
    'mut:coreBlocks.updateComposition': { ok: true },
  },
})
