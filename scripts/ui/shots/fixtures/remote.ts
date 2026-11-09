/**
 * Templates page (`/system/templates`) and the Remote extension on a media
 * player (`/devices/901?tab=customize`). Load BEFORE `customize`
 * (`--fixtures remote,customize`): the first area answering a path wins, and
 * the device reads fall through to the customize area for any other device.
 */
import {
  BUILTIN_REMOTE_COMPONENTS,
  builtinRemoteComponent,
  insertComponent,
  type RemoteLayoutPayload,
} from '@camstack/types'
import { planSourceSelectRow } from '../../../remote/source-select-row'
import { defineFixtures } from './_define'
import customizeArea from './customize'

const TV_ID = 901
const BOARD_ID = 902

const device = (id: number, name: string, type: string, location: string) => ({
  id,
  stableId: `dev-${id}`,
  addonId: 'provider-homeassistant',
  type,
  name,
  location,
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const TV = {
  ...device(TV_ID, 'Living room TV', 'media-player', 'Living room'),
  features: [
    'media-player-power',
    'media-player-volume',
    'media-player-mute',
    'media-player-next',
    'media-player-previous',
  ],
}
const PARENT_ID = 903
const PARENT = device(PARENT_ID, 'Living room IR board', 'generic', 'Living room')
const BOARD = {
  ...device(BOARD_ID, 'send_raw_command', 'generic', 'Living room'),
  parentDeviceId: PARENT_ID,
}
const PLUG_ID = 904
/** The smart plug the TV is powered through: its switch and its power reading feed the Power rows. */
const PLUG = {
  ...device(PLUG_ID, 'TV plug', 'switch', 'Living room'),
  features: ['switch', 'power-meter'],
}
const PLUG_REF = { addonId: PLUG.addonId, stableId: PLUG.stableId }
const TV_REF = { addonId: TV.addonId, stableId: TV.stableId }

/**
 * What an older compiler stored for a TV behind a plug: an explicit `, 1`
 * sample count on the running dwell and a `0` restart gap. Both are the
 * shapes the live hub carries, so the Power rows must still read as links.
 */
const TV_CUSTOMIZATION = {
  state: 'loaded',
  view: {
    block: {
      id: 'blk-tv',
      name: 'customize:tv',
      code: '',
      enabled: true,
      placement: 'hub',
      createdAt: 1,
      updatedAt: 1_700_000_000_000,
      createdBy: 'admin',
      status: 'running',
      lastChangedAt: 1,
      source: {
        kind: 'composition',
        composition: {
          target: { kind: 'existing', device: TV_REF },
          features: [
            {
              kind: 'fields',
              cap: 'power-source',
              fields: {
                switchOn: { kind: 'from', source: PLUG_REF, cap: 'switch', fieldPath: 'on' },
                offSeconds: { kind: 'expression', expr: '0', bindings: {} },
                lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
              },
            },
            {
              kind: 'fields',
              cap: 'running-state',
              fields: {
                running: {
                  kind: 'expression',
                  expr: 'dwell(x >= 20, 10000, 10000, 1)',
                  bindings: {
                    x: { kind: 'from', source: PLUG_REF, cap: 'power-meter', fieldPath: 'power' },
                  },
                },
                source: { kind: 'expression', expr: '"assigned"', bindings: {} },
                phase: { kind: 'expression', expr: 'null', bindings: {} },
                lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
                since: {
                  kind: 'expression',
                  expr: 'latchedAt(running)',
                  bindings: {
                    running: {
                      kind: 'from',
                      source: TV_REF,
                      cap: 'running-state',
                      fieldPath: 'running',
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
    state: { kind: 'answered', state: null },
  },
}

const delegate = (path: string, input: unknown): unknown => {
  const h = customizeArea.handlers[path]
  return typeof h === 'function' ? (h as (i: unknown) => unknown)(input) : h
}

const button = (
  id: string,
  row: number,
  col: number,
  role: string,
  icon: string | null,
  label: string | null,
  rowSpan = 1,
  colSpan = 1,
) => ({
  id,
  row,
  col,
  rowSpan,
  colSpan,
  role,
  ...(icon === null ? {} : { icon }),
  ...(label === null ? {} : { label }),
})

const TV_LAYOUT = {
  columns: 3,
  rows: 6,
  buttons: [
    button('b1', 0, 0, 'power', 'power', null),
    button('b2', 0, 2, 'mute', 'volume-x', null),
    button('b3', 1, 1, 'up', 'chevron-up', null),
    button('b4', 2, 0, 'left', 'chevron-left', null),
    button('b5', 2, 1, 'ok', null, 'OK'),
    button('b6', 2, 2, 'right', 'chevron-right', null),
    button('b7', 3, 1, 'down', 'chevron-down', null),
    button('b8', 4, 0, 'volume_up', 'volume-2', null, 2, 1),
    button('b9', 4, 2, 'channel_up', 'chevron-up', 'CH', 2, 1),
    button('b10', 5, 1, 'custom:hdmi_1', null, 'HDMI 1'),
  ],
}

/** A remote composed from palette components: a divider, a D-pad, rockers and a keypad. */
function composedLayout(): RemoteLayoutPayload {
  let layout: RemoteLayoutPayload = { columns: 6, rows: 11, buttons: [] }
  const put = (id: string, row: number, col: number, scale?: { cols: number }): void => {
    const result = insertComponent(
      layout,
      builtinRemoteComponent(id),
      { row, col },
      scale ? { scale } : {},
    )
    if (!result.ok) throw new Error(`fixture: ${id} refused (${result.reason})`)
    layout = result.layout
  }
  put('core:power', 0, 0)
  put('core:section-divider', 1, 0, { cols: 6 })
  put('core:dpad', 2, 0)
  put('core:rocker-volume-v', 2, 4)
  put('core:rocker-channel-v', 2, 5)
  put('core:keypad', 6, 0)
  put('core:colour-keys', 10, 0)
  const plan = planSourceSelectRow(layout)
  if (plan.status !== 'insert') throw new Error(`fixture: source_select ${plan.status}`)
  return plan.layout
}

const TEMPLATES = [
  {
    id: 'tpl-composed',
    kind: 'remote',
    name: 'Composed remote',
    payload: composedLayout(),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_300_000,
  },
  {
    id: 'tpl-tv',
    kind: 'remote',
    name: 'Television',
    payload: TV_LAYOUT,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
  },
  {
    id: 'tpl-soundbar',
    kind: 'remote',
    name: 'Soundbar',
    payload: {
      columns: 3,
      rows: 2,
      buttons: [
        button('s1', 0, 0, 'power', 'power', null),
        button('s2', 0, 1, 'volume_down', 'volume-1', null),
        button('s3', 0, 2, 'volume_up', 'volume-2', null),
        button('s4', 1, 0, 'mute', 'volume-x', null),
      ],
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_200_000,
  },
]

const irBinding = (note: string) => ({
  action: {
    kind: 'cap',
    deviceId: BOARD_ID,
    cap: 'ir-transmitter',
    method: 'send',
    args: { timings: [9000, 4500, 560, 560, 560], note },
  },
})

const ARTWORK =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='200' height='200' fill='gray'/><circle cx='100' cy='100' r='60' fill='silver'/></svg>"

/** A player that reports playback but no volume level (an imported speaker): volume is declared, its level unknown. */
const TV_MEDIA_PLAYER = {
  state: 'playing',
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: null,
  isMuted: null,
  source: '',
  availableSources: [],
  currentMedia: { title: 'Evening mix', artist: 'The Band', imageUrl: ARTWORK },
  position: null,
  duration: null,
  shuffle: null,
  repeat: null,
  lastChangedAt: 1,
}

const REMOTE_CONFIG = {
  layoutTemplateId: 'tpl-composed',
  defaultTransmitterId: BOARD_ID,
  bindings: {
    power: irBinding('power'),
    mute: irBinding('mute'),
    volume_up: irBinding('volume_up'),
    'custom:hdmi_1': irBinding('hdmi_1'),
  },
  customButtons: [{ key: 'hdmi_1', name: 'HDMI 1' }],
  sources: [
    { id: 'rai-1', kind: 'digits', name: 'Rai 1', number: '1' },
    { id: 'rai-2', kind: 'digits', name: 'Rai 2', number: '2' },
    { id: 'hdmi-1', kind: 'sequence', name: 'HDMI 1', steps: ['custom:hdmi_1'] },
    { id: 'quiet-hdmi', kind: 'sequence', name: 'HDMI 1, muted', steps: ['mute', 'custom:hdmi_1'] },
  ],
  stepDelayMs: 500,
}

export default defineFixtures({
  area: 'remote',
  description: 'Templates page and the Remote Customize extension on a media player',
  handlers: {
    'auth.listLoginMethods': [],
    'preferences.get': { rows: [] },
    'remoteLayoutComponents.listComponents': BUILTIN_REMOTE_COMPONENTS,
    'template.list': TEMPLATES,
    'template.get': (i: { id: string }) => TEMPLATES.find((t) => t.id === i.id) ?? null,
    'mut:template.create': (i: { kind: string; name: string; payload: unknown }) => ({
      status: 'saved',
      template: { id: 'tpl-new', ...i, createdAt: 1, updatedAt: 1 },
    }),
    'mut:template.update': (i: { id: string }) => ({
      status: 'saved',
      template: {
        ...(TEMPLATES.find((t) => t.id === i.id) ?? TEMPLATES[0]),
        updatedAt: 2,
      },
    }),
    'mut:template.delete': (i: { id: string }) =>
      i.id === 'tpl-tv'
        ? { status: 'in-use', devices: [{ deviceId: TV_ID, name: TV.name }] }
        : { status: 'deleted' },
    'capabilities.getCapability': {
      name: 'remote',
      mode: 'singleton',
      providers: ['remote'],
      activeProvider: 'remote',
      disabledProviders: [],
    },
    'powerSource.getStatus': {
      linked: false,
      switchDeviceId: null,
      switchName: null,
      switchOn: null,
      switchOnline: null,
      restartInProgress: false,
      offSeconds: 0,
    },
    'deviceState.getSnapshot': (i: { deviceId?: number }) =>
      i.deviceId === TV_ID
        ? { 'media-player': TV_MEDIA_PLAYER }
        : delegate('deviceState.getSnapshot', i),
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      i.deviceId === TV_ID && i.capName === 'media-player'
        ? TV_MEDIA_PLAYER
        : delegate('deviceState.getCapSlice', i),
    'mediaPlayer.getStatus': TV_MEDIA_PLAYER,
    'remote.getConfig': REMOTE_CONFIG,
    'mut:remote.setConfig': { status: 'saved' },
    'remote.listCommands': {
      layoutTemplateId: 'tpl-composed',
      commands: [
        { role: 'power', custom: false },
        { role: 'mute', custom: false },
        { role: 'volume_up', custom: false },
        { role: 'custom:hdmi_1', label: 'HDMI 1', custom: true },
      ],
      sources: REMOTE_CONFIG.sources,
    },
    'remote.getAssumedStatus': { ...TV_MEDIA_PLAYER, source: 'Rai 1' },
    'mut:remote.sendMediaCommand': { status: 'sent', sends: 1 },
    'mut:remote.sendCommand': { status: 'sent', sends: 1 },
    'deviceManager.listDeviceIdsByCaps': (i: { capNames?: readonly string[] }) =>
      i.capNames?.includes('ir-transmitter') === true
        ? [BOARD_ID]
        : delegate('deviceManager.listDeviceIdsByCaps', i),
    'coreBlocks.listComposableCaps': {
      caps: [
        ...(delegate('coreBlocks.listComposableCaps', undefined) as { caps: unknown[] }).caps,
        { cap: 'power-source' },
      ],
    },
    'coreBlocks.getCustomization': (i: { stableId?: string }) =>
      i.stableId === TV.stableId ? TV_CUSTOMIZATION : delegate('coreBlocks.getCustomization', i),
    'deviceManager.getDevice': (i: { deviceId: number }) =>
      i.deviceId === TV_ID
        ? TV
        : i.deviceId === BOARD_ID
          ? BOARD
          : i.deviceId === PLUG_ID
            ? PLUG
            : delegate('deviceManager.getDevice', i),
    'deviceManager.listAll': [
      TV,
      BOARD,
      PARENT,
      PLUG,
      ...((customizeArea.handlers['deviceManager.listAll'] as unknown[]) ?? []),
    ],
    'deviceManager.getBindings': (i: { deviceId: number }) =>
      i.deviceId === TV_ID
        ? {
            entries: [
              {
                capName: 'media-player',
                nativeAddonId: 'provider-homeassistant',
              },
            ],
          }
        : delegate('deviceManager.getBindings', i),
    'deviceManager.getDeviceAggregate': (i: { deviceId: number }) =>
      i.deviceId === TV_ID || i.deviceId === BOARD_ID
        ? {
            settings: { tabs: [], sections: [] },
            live: { sections: [] },
            tabs: undefined,
            deviceId: i.deviceId,
          }
        : delegate('deviceManager.getDeviceAggregate', i),
  },
})
