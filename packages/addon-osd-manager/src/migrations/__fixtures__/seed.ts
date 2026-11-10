/**
 * The legacy data the `osd-manager` catalogue meets on a node that last ran a release which kept
 * slot bindings as source + displayUnit/maxDecimals/valueMap/`${value}` wrapper and named templates
 * as alias bindings + a `{alias.part}` parser: written by hand, in the shape that release stored it.
 * The schedule and the gate on `text-1` are the marks a migration that rebuilt a slot would drop.
 * The migration spec seeds from here.
 */
export const CAMERA = 101
export const GARAGE = 7

export const SCHEDULE = { windows: [{ days: [1, 2], startMinute: 60, endMinute: 120 }] }
export const CONDITIONS = { deviceState: { deviceId: GARAGE, states: ['on'] } }

export const LEGACY_TEMPLATES = [
  {
    id: 'garage',
    name: 'Garage',
    bindings: [
      {
        alias: 't',
        pick: { deviceId: GARAGE },
        capName: 'temperature-sensor',
        valuePath: 'temperature',
        displayUnit: '°C',
        maxDecimals: 1,
      },
      {
        alias: 'h',
        pick: { deviceId: GARAGE },
        capName: 'humidity-sensor',
        valuePath: 'humidity',
        maxDecimals: 0,
      },
      {
        alias: 's',
        pick: { deviceId: GARAGE },
        capName: 'switch',
        valuePath: 'on',
        maxDecimals: 1,
        valueMap: { true: 'OPEN', false: 'CLOSED' },
      },
    ],
    parser: '{t.full} ({h.full}) {s} {t.value} {t.unit}',
  },
]

export const LEGACY_SLOTS = {
  'text-1': {
    enabled: true,
    source: { kind: 'device-state', capName: 'motion', valuePath: 'detected' },
    template: '[${value}]',
    maxDecimals: 1,
    valueMap: { true: 'MOTION', false: '' },
    schedule: SCHEDULE,
    conditions: CONDITIONS,
  },
  'text-2': {
    enabled: true,
    source: { kind: 'clock', pattern: 'HH:mm' },
    template: '${value}',
    maxDecimals: 1,
  },
  'text-3': {
    enabled: false,
    source: { kind: 'latest-recognition', recognition: 'person' },
    template: 'Who: ${value}',
    maxDecimals: 1,
  },
  'text-4': {
    enabled: true,
    source: {
      kind: 'device-state',
      deviceId: GARAGE,
      capName: 'temperature-sensor',
      valuePath: 'temperature',
      displayUnit: '°F',
    },
    template: '${value}${unit}',
    maxDecimals: 0,
  },
  'text-5': {
    enabled: true,
    source: { kind: 'static', text: 'GATE' },
    template: '${value}',
    maxDecimals: 1,
  },
  'text-6': {
    enabled: true,
    source: { kind: 'template', templateId: 'garage' },
    template: '${value}',
    maxDecimals: 1,
  },
}
