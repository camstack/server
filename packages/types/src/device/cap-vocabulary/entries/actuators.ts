/**
 * Things an operator switches, opens, sets or arms: lights, plugs, sirens,
 * covers, valves, locks, climate, fans, alarm panels.
 */
import { DeviceRole, DeviceType } from '../../device-type.js'
import { t } from '../l10n.js'
import type { CapVocabularySlice } from '../types.js'

const ON = t('On', 'Acceso')
const PERCENT = t('Percentage', 'Percentuale')

type ActuatorCap =
  | 'switch'
  | 'brightness'
  | 'color'
  | 'cover'
  | 'valve'
  | 'lock-control'
  | 'climate-control'
  | 'fan-control'
  | 'humidifier'
  | 'water-heater'
  | 'heating-valve'
  | 'alarm-panel'
  | 'button'
  | 'control'
  | 'motion-trigger'

const OPEN_CLOSE_STATES = [
  {
    value: 'open',
    label: t('Open', 'Aperto'),
    phrase: t('When {device} is fully open', 'Quando {device} è tutto aperto'),
  },
  {
    value: 'opening',
    label: t('Opening', 'In apertura'),
    phrase: t('When {device} starts opening', 'Quando {device} inizia ad aprirsi'),
  },
  {
    value: 'closing',
    label: t('Closing', 'In chiusura'),
    phrase: t('When {device} starts closing', 'Quando {device} inizia a chiudersi'),
  },
  {
    value: 'closed',
    label: t('Closed', 'Chiuso'),
    phrase: t('When {device} is fully closed', 'Quando {device} è tutto chiuso'),
  },
  {
    value: 'stopped',
    label: t('Stopped', 'Fermo'),
    phrase: t('When {device} stops part-way', 'Quando {device} si ferma a metà'),
  },
]

/** The actuator family of the vocabulary. */
export const ACTUATOR_CAP_VOCABULARY: CapVocabularySlice<ActuatorCap> = {
  switch: {
    scope: 'device',
    noun: t('Switch', 'Interruttore'),
    actions: [
      {
        id: 'switch.on',
        method: 'setState',
        label: t('Turn on', 'Accendi'),
        phrase: t('Turn on {device}', 'Accendi {device}'),
        icon: 'power',
        args: { on: true },
      },
      {
        id: 'switch.off',
        method: 'setState',
        label: t('Turn off', 'Spegni'),
        phrase: t('Turn off {device}', 'Spegni {device}'),
        icon: 'power-off',
        args: { on: false },
      },
    ],
    state: [
      {
        kind: 'boolean',
        field: 'on',
        label: ON,
        whenTrue: t('When {device} turns on', 'Quando {device} si accende'),
        whenFalse: t('When {device} turns off', 'Quando {device} si spegne'),
        icon: 'power',
      },
    ],
    events: {
      onStateChanged: {
        notOperatorFacing: 'the `on` state trigger phrases both edges of this change',
      },
    },
    overrides: {
      byType: {
        [DeviceType.Siren]: {
          actions: {
            'switch.on': {
              label: t('Sound', 'Fai suonare'),
              phrase: t('Sound {device}', 'Fai suonare {device}'),
              icon: 'siren',
            },
            'switch.off': {
              label: t('Silence', 'Zittisci'),
              phrase: t('Silence {device}', 'Zittisci {device}'),
              icon: 'volume-x',
            },
          },
          state: {
            on: {
              label: t('Sounding', 'In funzione'),
              whenTrue: t('When {device} starts sounding', 'Quando {device} inizia a suonare'),
              whenFalse: t('When {device} falls silent', 'Quando {device} smette di suonare'),
              icon: 'siren',
            },
          },
        },
        [DeviceType.Light]: {
          actions: {
            'switch.on': { icon: 'lightbulb' },
            'switch.off': { icon: 'lightbulb-off' },
          },
          state: { on: { icon: 'lightbulb' } },
        },
      },
      byRole: {
        [DeviceRole.Siren]: {
          actions: {
            'switch.on': {
              label: t('Sound', 'Fai suonare'),
              phrase: t('Sound {device}', 'Fai suonare {device}'),
              icon: 'siren',
            },
            'switch.off': {
              label: t('Silence', 'Zittisci'),
              phrase: t('Silence {device}', 'Zittisci {device}'),
              icon: 'volume-x',
            },
          },
          state: {
            on: {
              label: t('Sounding', 'In funzione'),
              whenTrue: t('When {device} starts sounding', 'Quando {device} inizia a suonare'),
              whenFalse: t('When {device} falls silent', 'Quando {device} smette di suonare'),
              icon: 'siren',
            },
          },
        },
        [DeviceRole.Floodlight]: {
          actions: {
            'switch.on': { icon: 'lightbulb' },
            'switch.off': { icon: 'lightbulb-off' },
          },
          state: { on: { icon: 'lightbulb' } },
        },
        [DeviceRole.Spotlight]: {
          actions: {
            'switch.on': { icon: 'lightbulb' },
            'switch.off': { icon: 'lightbulb-off' },
          },
          state: { on: { icon: 'lightbulb' } },
        },
        [DeviceRole.Chime]: {
          actions: {
            'switch.on': {
              label: t('Enable chime', 'Attiva il campanello'),
              phrase: t('Enable the chime {device}', 'Attiva il campanello {device}'),
              icon: 'bell',
            },
            'switch.off': {
              label: t('Mute chime', 'Silenzia il campanello'),
              phrase: t('Mute the chime {device}', 'Silenzia il campanello {device}'),
              icon: 'bell-off',
            },
          },
        },
        [DeviceRole.PirSensor]: {
          actions: {
            'switch.on': {
              label: t('Arm PIR', 'Attiva il PIR'),
              phrase: t('Arm the PIR sensor {device}', 'Attiva il sensore PIR {device}'),
              icon: 'radar',
            },
            'switch.off': {
              label: t('Disarm PIR', 'Disattiva il PIR'),
              phrase: t('Disarm the PIR sensor {device}', 'Disattiva il sensore PIR {device}'),
              icon: 'radar',
            },
          },
        },
        [DeviceRole.Nightvision]: {
          actions: {
            'switch.on': {
              label: t('Night vision on', 'Visione notturna attiva'),
              phrase: t(
                'Turn on night vision on {device}',
                'Attiva la visione notturna di {device}',
              ),
              icon: 'moon',
            },
            'switch.off': {
              label: t('Night vision off', 'Visione notturna spenta'),
              phrase: t(
                'Turn off night vision on {device}',
                'Disattiva la visione notturna di {device}',
              ),
              icon: 'sun',
            },
          },
        },
        [DeviceRole.PrivacyMask]: {
          actions: {
            'switch.on': {
              label: t('Privacy on', 'Privacy attiva'),
              phrase: t('Turn on privacy on {device}', 'Attiva la privacy su {device}'),
              icon: 'eye-off',
            },
            'switch.off': {
              label: t('Privacy off', 'Privacy disattiva'),
              phrase: t('Turn off privacy on {device}', 'Disattiva la privacy su {device}'),
              icon: 'eye',
            },
          },
        },
        [DeviceRole.Autotrack]: {
          actions: {
            'switch.on': {
              label: t('Autotrack on', 'Inseguimento attivo'),
              phrase: t('Start autotracking on {device}', 'Attiva l’inseguimento su {device}'),
              icon: 'crosshair',
            },
            'switch.off': {
              label: t('Autotrack off', 'Inseguimento spento'),
              phrase: t('Stop autotracking on {device}', 'Disattiva l’inseguimento su {device}'),
              icon: 'crosshair',
            },
          },
        },
        [DeviceRole.Outlet]: {
          actions: {
            'switch.on': { icon: 'plug-zap' },
            'switch.off': { icon: 'plug' },
          },
          state: { on: { icon: 'plug-zap' } },
        },
      },
    },
  },

  brightness: {
    scope: 'device',
    noun: t('Brightness', 'Luminosità'),
    actions: [
      {
        id: 'brightness.full',
        method: 'setBrightness',
        label: t('Full brightness', 'Luminosità massima'),
        phrase: t('Set {device} to full brightness', 'Porta {device} alla massima luminosità'),
        icon: 'sun',
        args: { level: 100 },
      },
      {
        id: 'brightness.half',
        method: 'setBrightness',
        label: t('Half brightness', 'Luminosità a metà'),
        phrase: t('Dim {device} to half', 'Abbassa {device} a metà luminosità'),
        icon: 'sun-dim',
        args: { level: 50 },
      },
      {
        id: 'brightness.off',
        method: 'setBrightness',
        label: t('Brightness off', 'Luminosità a zero'),
        phrase: t('Dim {device} to zero', 'Abbassa {device} a zero'),
        icon: 'lightbulb-off',
        args: { level: 0 },
      },
      {
        id: 'brightness.set',
        method: 'setBrightness',
        label: t('Set brightness', 'Imposta la luminosità'),
        phrase: t(
          'Set the brightness of {device} to {level}',
          'Imposta la luminosità di {device} a {level}',
        ),
        icon: 'sun-medium',
        openArgs: [
          {
            key: 'level',
            label: PERCENT,
            offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
          },
        ],
      },
    ],
    state: [
      {
        kind: 'numeric',
        field: 'level',
        quantity: t('the brightness', 'la luminosità'),
        label: t('Brightness', 'Luminosità'),
        unit: '%',
        icon: 'sun',
      },
    ],
    events: {
      onBrightnessChanged: {
        notOperatorFacing: 'the `level` state trigger reads the same change',
      },
    },
  },

  color: {
    scope: 'device',
    noun: t('Colour', 'Colore'),
    actions: [
      {
        id: 'color.warmWhite',
        method: 'setColor',
        label: t('Warm white', 'Bianco caldo'),
        phrase: t('Set {device} to warm white', 'Imposta {device} su bianco caldo'),
        icon: 'sun',
        args: { color: { mode: 'mired', colorTemperature: 370 } },
      },
      {
        id: 'color.coolWhite',
        method: 'setColor',
        label: t('Cool white', 'Bianco freddo'),
        phrase: t('Set {device} to cool white', 'Imposta {device} su bianco freddo'),
        icon: 'snowflake',
        args: { color: { mode: 'mired', colorTemperature: 200 } },
      },
      {
        id: 'color.red',
        method: 'setColor',
        label: t('Red', 'Rosso'),
        phrase: t('Turn {device} red', 'Colora {device} di rosso'),
        icon: 'palette',
        args: { color: { mode: 'rgb', rgb: { r: 255, g: 0, b: 0 } } },
      },
      {
        id: 'color.green',
        method: 'setColor',
        label: t('Green', 'Verde'),
        phrase: t('Turn {device} green', 'Colora {device} di verde'),
        icon: 'palette',
        args: { color: { mode: 'rgb', rgb: { r: 0, g: 255, b: 0 } } },
      },
      {
        id: 'color.blue',
        method: 'setColor',
        label: t('Blue', 'Blu'),
        phrase: t('Turn {device} blue', 'Colora {device} di blu'),
        icon: 'palette',
        args: { color: { mode: 'rgb', rgb: { r: 0, g: 0, b: 255 } } },
      },
    ],
    state: [
      {
        kind: 'enum',
        field: 'mode',
        label: t('Colour mode', 'Modalità colore'),
        values: [
          { value: 'rgb', label: t('RGB colour', 'Colore RGB') },
          { value: 'hsv', label: t('HSV colour', 'Colore HSV') },
          {
            value: 'mired',
            label: t('White temperature', 'Temperatura del bianco'),
          },
        ],
        icon: 'palette',
      },
    ],
    events: {
      onColorChanged: {
        notOperatorFacing: 'a colour change is read through the `mode` state trigger',
      },
    },
  },

  cover: {
    scope: 'device',
    noun: t('Cover', 'Copertura'),
    actions: [
      {
        id: 'cover.open',
        method: 'open',
        label: t('Open', 'Apri'),
        phrase: t('Open {device}', 'Apri {device}'),
        icon: 'arrow-up-to-line',
      },
      {
        id: 'cover.close',
        method: 'close',
        label: t('Close', 'Chiudi'),
        phrase: t('Close {device}', 'Chiudi {device}'),
        icon: 'arrow-down-to-line',
      },
      {
        id: 'cover.stop',
        method: 'stop',
        label: t('Stop', 'Ferma'),
        phrase: t('Stop {device}', 'Ferma {device}'),
        icon: 'square',
      },
      {
        id: 'cover.position',
        method: 'setPosition',
        label: t('Set position', 'Imposta la posizione'),
        phrase: t('Move {device} to {position} open', 'Porta {device} al {position} di apertura'),
        icon: 'blinds',
        openArgs: [
          {
            key: 'position',
            label: t('Position', 'Posizione'),
            offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
          },
        ],
      },
      {
        id: 'cover.tilt',
        method: 'setTiltPosition',
        label: t('Set tilt', 'Imposta l’inclinazione'),
        phrase: t('Tilt {device} to {tiltPosition}', 'Inclina {device} al {tiltPosition}'),
        icon: 'blinds',
        openArgs: [
          {
            key: 'tiltPosition',
            label: t('Tilt', 'Inclinazione'),
            offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
          },
        ],
      },
    ],
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('State', 'Stato'),
        values: OPEN_CLOSE_STATES,
        icon: 'blinds',
      },
      {
        kind: 'numeric',
        field: 'position',
        quantity: t('the opening', 'l’apertura'),
        label: t('Position', 'Posizione'),
        unit: '%',
        icon: 'blinds',
      },
    ],
    overrides: {
      byRole: {
        [DeviceRole.CoverGarage]: {
          actions: {
            'cover.open': {
              phrase: t('Open the garage door {device}', 'Apri il garage {device}'),
              icon: 'warehouse',
            },
            'cover.close': {
              phrase: t('Close the garage door {device}', 'Chiudi il garage {device}'),
              icon: 'warehouse',
            },
          },
        },
        [DeviceRole.CoverGate]: {
          actions: {
            'cover.open': {
              phrase: t('Open the gate {device}', 'Apri il cancello {device}'),
              icon: 'fence',
            },
            'cover.close': {
              phrase: t('Close the gate {device}', 'Chiudi il cancello {device}'),
              icon: 'fence',
            },
          },
        },
        [DeviceRole.CoverDoor]: {
          actions: {
            'cover.open': {
              phrase: t('Open the door {device}', 'Apri la porta {device}'),
              icon: 'door-open',
            },
            'cover.close': {
              phrase: t('Close the door {device}', 'Chiudi la porta {device}'),
              icon: 'door-closed',
            },
          },
        },
        [DeviceRole.CoverWindow]: {
          actions: {
            'cover.open': {
              phrase: t('Open the window {device}', 'Apri la finestra {device}'),
              icon: 'app-window',
            },
            'cover.close': {
              phrase: t('Close the window {device}', 'Chiudi la finestra {device}'),
              icon: 'app-window',
            },
          },
        },
        [DeviceRole.CoverShutter]: {
          actions: {
            'cover.open': {
              phrase: t('Raise the shutter {device}', 'Alza la tapparella {device}'),
            },
            'cover.close': {
              phrase: t('Lower the shutter {device}', 'Abbassa la tapparella {device}'),
            },
          },
        },
        [DeviceRole.CoverAwning]: {
          actions: {
            'cover.open': {
              phrase: t('Extend the awning {device}', 'Apri la tenda da sole {device}'),
            },
            'cover.close': {
              phrase: t('Retract the awning {device}', 'Chiudi la tenda da sole {device}'),
            },
          },
        },
      },
    },
  },

  valve: {
    scope: 'device',
    noun: t('Valve', 'Valvola'),
    actions: [
      {
        id: 'valve.open',
        method: 'open',
        label: t('Open valve', 'Apri la valvola'),
        phrase: t('Open {device}', 'Apri {device}'),
        icon: 'droplets',
      },
      {
        id: 'valve.close',
        method: 'close',
        label: t('Close valve', 'Chiudi la valvola'),
        phrase: t('Close {device}', 'Chiudi {device}'),
        icon: 'droplet-off',
      },
      {
        id: 'valve.stop',
        method: 'stop',
        label: t('Stop valve', 'Ferma la valvola'),
        phrase: t('Stop {device}', 'Ferma {device}'),
        icon: 'square',
      },
      {
        id: 'valve.position',
        method: 'setPosition',
        label: t('Set opening', 'Imposta l’apertura'),
        phrase: t('Open {device} to {position}', 'Apri {device} al {position}'),
        icon: 'droplets',
        openArgs: [
          {
            key: 'position',
            label: t('Opening', 'Apertura'),
            offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
          },
        ],
      },
    ],
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('State', 'Stato'),
        values: OPEN_CLOSE_STATES,
        icon: 'droplets',
      },
      {
        kind: 'numeric',
        field: 'position',
        quantity: t('the opening', 'l’apertura'),
        label: t('Opening', 'Apertura'),
        unit: '%',
        icon: 'droplets',
      },
    ],
  },

  'lock-control': {
    scope: 'device',
    noun: t('Lock', 'Serratura'),
    actions: [
      {
        id: 'lock.lock',
        method: 'lock',
        label: t('Lock', 'Chiudi a chiave'),
        phrase: t('Lock {device}', 'Chiudi a chiave {device}'),
        icon: 'lock',
        openArgs: [
          {
            key: 'code',
            label: t('PIN code', 'Codice PIN'),
            offer: { kind: 'text', secret: true },
            optional: true,
          },
        ],
      },
      {
        id: 'lock.unlock',
        method: 'unlock',
        label: t('Unlock', 'Apri la serratura'),
        phrase: t('Unlock {device}', 'Sblocca {device}'),
        icon: 'lock-open',
        openArgs: [
          {
            key: 'code',
            label: t('PIN code', 'Codice PIN'),
            offer: { kind: 'text', secret: true },
            optional: true,
          },
        ],
      },
      {
        id: 'lock.open',
        method: 'open',
        label: t('Open latch', 'Apri lo scrocco'),
        phrase: t('Release the latch of {device}', 'Fai scattare lo scrocco di {device}'),
        icon: 'door-open',
      },
    ],
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('Lock state', 'Stato della serratura'),
        values: [
          {
            value: 'locked',
            label: t('Locked', 'Chiusa a chiave'),
            phrase: t('When {device} locks', 'Quando {device} si chiude a chiave'),
          },
          {
            value: 'unlocked',
            label: t('Unlocked', 'Sbloccata'),
            phrase: t('When {device} unlocks', 'Quando {device} si sblocca'),
          },
          {
            value: 'locking',
            label: t('Locking', 'In chiusura'),
            phrase: t('When {device} starts locking', 'Quando {device} inizia a chiudersi'),
          },
          {
            value: 'unlocking',
            label: t('Unlocking', 'In apertura'),
            phrase: t('When {device} starts unlocking', 'Quando {device} inizia a sbloccarsi'),
          },
          {
            value: 'jammed',
            label: t('Jammed', 'Inceppata'),
            phrase: t('When {device} jams', 'Quando {device} si inceppa'),
          },
        ],
        icon: 'lock',
      },
    ],
  },

  'climate-control': {
    scope: 'device',
    noun: t('Climate', 'Clima'),
    actions: [
      {
        id: 'climate.off',
        method: 'setMode',
        label: t('Climate off', 'Clima spento'),
        phrase: t('Turn off {device}', 'Spegni {device}'),
        icon: 'power-off',
        args: { mode: 'off' },
      },
      {
        id: 'climate.heat',
        method: 'setMode',
        label: t('Heat', 'Riscalda'),
        phrase: t('Set {device} to heat', 'Metti {device} in riscaldamento'),
        icon: 'flame',
        args: { mode: 'heat' },
      },
      {
        id: 'climate.cool',
        method: 'setMode',
        label: t('Cool', 'Raffresca'),
        phrase: t('Set {device} to cool', 'Metti {device} in raffrescamento'),
        icon: 'snowflake',
        args: { mode: 'cool' },
      },
      {
        id: 'climate.auto',
        method: 'setMode',
        label: t('Climate auto', 'Clima automatico'),
        phrase: t('Set {device} to automatic', 'Metti {device} in automatico'),
        icon: 'thermometer',
        args: { mode: 'auto' },
      },
      {
        id: 'climate.mode',
        method: 'setMode',
        label: t('Set mode', 'Imposta la modalità'),
        phrase: t('Set {device} to {mode}', 'Imposta {device} su {mode}'),
        icon: 'thermometer',
        openArgs: [
          {
            key: 'mode',
            label: t('Mode', 'Modalità'),
            offer: {
              kind: 'enum',
              values: [
                { value: 'off', label: t('Off', 'Spento') },
                { value: 'heat', label: t('Heat', 'Riscaldamento') },
                { value: 'cool', label: t('Cool', 'Raffrescamento') },
                { value: 'auto', label: t('Automatic', 'Automatico') },
                {
                  value: 'heat_cool',
                  label: t('Heat and cool', 'Caldo e freddo'),
                },
                {
                  value: 'fan_only',
                  label: t('Fan only', 'Solo ventilazione'),
                },
                { value: 'dry', label: t('Dry', 'Deumidificazione') },
              ],
            },
          },
        ],
      },
      {
        id: 'climate.target',
        method: 'setTarget',
        label: t('Set temperature', 'Imposta la temperatura'),
        phrase: t('Set {device} to {target}', 'Imposta {device} a {target}'),
        icon: 'thermometer',
        openArgs: [
          {
            key: 'target',
            label: t('Temperature', 'Temperatura'),
            offer: { kind: 'number', step: 0.5, unit: '°C' },
          },
        ],
      },
      {
        id: 'climate.targetRange',
        method: 'setTargetRange',
        label: t('Set temperature range', 'Imposta l’intervallo di temperatura'),
        phrase: t(
          'Keep {device} between {targetLow} and {targetHigh}',
          'Mantieni {device} tra {targetLow} e {targetHigh}',
        ),
        icon: 'thermometer',
        openArgs: [
          {
            key: 'targetLow',
            label: t('Lowest', 'Minima'),
            offer: { kind: 'number', step: 0.5, unit: '°C' },
          },
          {
            key: 'targetHigh',
            label: t('Highest', 'Massima'),
            offer: { kind: 'number', step: 0.5, unit: '°C' },
          },
        ],
      },
      {
        id: 'climate.targetHumidity',
        method: 'setTargetHumidity',
        label: t('Set humidity', 'Imposta l’umidità'),
        phrase: t(
          'Set the humidity target of {device} to {targetHumidity}',
          'Imposta l’umidità obiettivo di {device} al {targetHumidity}',
        ),
        icon: 'droplets',
        openArgs: [
          {
            key: 'targetHumidity',
            label: t('Humidity', 'Umidità'),
            offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
          },
        ],
      },
      {
        id: 'climate.fanMode',
        method: 'setFanMode',
        label: t('Set fan mode', 'Imposta la ventilazione'),
        phrase: t(
          'Set the fan of {device} to {fanMode}',
          'Imposta la ventilazione di {device} su {fanMode}',
        ),
        icon: 'fan',
        openArgs: [
          {
            key: 'fanMode',
            label: t('Fan mode', 'Ventilazione'),
            offer: {
              kind: 'dynamic',
              from: 'status',
              field: 'availableFanModes',
            },
          },
        ],
      },
      {
        id: 'climate.preset',
        method: 'setPreset',
        label: t('Set preset', 'Imposta il preset'),
        phrase: t('Set {device} to preset {preset}', 'Imposta {device} sul preset {preset}'),
        icon: 'list',
        openArgs: [
          {
            key: 'preset',
            label: t('Preset', 'Preset'),
            offer: {
              kind: 'dynamic',
              from: 'status',
              field: 'availablePresets',
            },
          },
        ],
      },
      {
        id: 'climate.swingVerticalOn',
        method: 'setSwingVertical',
        label: t('Vertical swing on', 'Oscillazione verticale attiva'),
        phrase: t(
          'Start the vertical swing of {device}',
          'Attiva l’oscillazione verticale di {device}',
        ),
        icon: 'move-vertical',
        args: { on: true },
      },
      {
        id: 'climate.swingVerticalOff',
        method: 'setSwingVertical',
        label: t('Vertical swing off', 'Oscillazione verticale spenta'),
        phrase: t(
          'Stop the vertical swing of {device}',
          'Ferma l’oscillazione verticale di {device}',
        ),
        icon: 'move-vertical',
        args: { on: false },
      },
      {
        id: 'climate.swingHorizontalOn',
        method: 'setSwingHorizontal',
        label: t('Horizontal swing on', 'Oscillazione orizzontale attiva'),
        phrase: t(
          'Start the horizontal swing of {device}',
          'Attiva l’oscillazione orizzontale di {device}',
        ),
        icon: 'move-horizontal',
        args: { on: true },
      },
      {
        id: 'climate.swingHorizontalOff',
        method: 'setSwingHorizontal',
        label: t('Horizontal swing off', 'Oscillazione orizzontale spenta'),
        phrase: t(
          'Stop the horizontal swing of {device}',
          'Ferma l’oscillazione orizzontale di {device}',
        ),
        icon: 'move-horizontal',
        args: { on: false },
      },
    ],
    state: [
      {
        kind: 'enum',
        field: 'mode',
        label: t('Mode', 'Modalità'),
        values: [
          {
            value: 'off',
            label: t('Off', 'Spento'),
            phrase: t('When {device} turns off', 'Quando {device} si spegne'),
          },
          {
            value: 'heat',
            label: t('Heat', 'Riscaldamento'),
            phrase: t('When {device} starts heating', 'Quando {device} passa al riscaldamento'),
          },
          {
            value: 'cool',
            label: t('Cool', 'Raffrescamento'),
            phrase: t('When {device} starts cooling', 'Quando {device} passa al raffrescamento'),
          },
          { value: 'auto', label: t('Automatic', 'Automatico') },
          { value: 'heat_cool', label: t('Heat and cool', 'Caldo e freddo') },
          { value: 'fan_only', label: t('Fan only', 'Solo ventilazione') },
          { value: 'dry', label: t('Dry', 'Deumidificazione') },
        ],
        icon: 'thermometer',
      },
      {
        kind: 'numeric',
        field: 'currentTemp',
        quantity: t('the temperature', 'la temperatura'),
        label: t('Temperature', 'Temperatura'),
        unit: '°C',
        icon: 'thermometer',
      },
      {
        kind: 'numeric',
        field: 'currentHumidity',
        quantity: t('the humidity', 'l’umidità'),
        label: t('Humidity', 'Umidità'),
        unit: '%',
        icon: 'droplets',
      },
      {
        kind: 'numeric',
        field: 'target',
        quantity: t('the set temperature', 'la temperatura impostata'),
        label: t('Set temperature', 'Temperatura impostata'),
        unit: '°C',
        icon: 'thermometer',
      },
    ],
  },

  'fan-control': {
    scope: 'device',
    noun: t('Fan', 'Ventilatore'),
    actions: [
      {
        id: 'fan.off',
        method: 'setPercentage',
        label: t('Fan off', 'Ventilatore spento'),
        phrase: t('Stop {device}', 'Ferma {device}'),
        icon: 'power-off',
        args: { speed: 0 },
      },
      {
        id: 'fan.full',
        method: 'setPercentage',
        label: t('Fan full', 'Ventilatore al massimo'),
        phrase: t('Run {device} at full speed', 'Porta {device} alla massima velocità'),
        icon: 'fan',
        args: { speed: 100 },
      },
      {
        id: 'fan.speed',
        method: 'setPercentage',
        label: t('Set speed', 'Imposta la velocità'),
        phrase: t(
          'Set the speed of {device} to {speed}',
          'Imposta la velocità di {device} al {speed}',
        ),
        icon: 'fan',
        openArgs: [
          {
            key: 'speed',
            label: t('Speed', 'Velocità'),
            offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
          },
        ],
      },
      {
        id: 'fan.preset',
        method: 'setPreset',
        label: t('Set preset', 'Imposta il preset'),
        phrase: t('Set {device} to preset {preset}', 'Imposta {device} sul preset {preset}'),
        icon: 'list',
        openArgs: [
          {
            key: 'preset',
            label: t('Preset', 'Preset'),
            offer: {
              kind: 'dynamic',
              from: 'status',
              field: 'availablePresets',
            },
          },
        ],
      },
      {
        id: 'fan.forward',
        method: 'setDirection',
        label: t('Spin forward', 'Rotazione avanti'),
        phrase: t('Spin {device} forward', 'Fai girare {device} in avanti'),
        icon: 'rotate-cw',
        args: { direction: 'forward' },
      },
      {
        id: 'fan.reverse',
        method: 'setDirection',
        label: t('Spin in reverse', 'Rotazione inversa'),
        phrase: t('Spin {device} in reverse', 'Fai girare {device} al contrario'),
        icon: 'rotate-ccw',
        args: { direction: 'reverse' },
      },
      {
        id: 'fan.oscillateOn',
        method: 'setOscillating',
        label: t('Oscillate', 'Oscillazione attiva'),
        phrase: t('Make {device} oscillate', 'Fai oscillare {device}'),
        icon: 'move-horizontal',
        args: { oscillating: true },
      },
      {
        id: 'fan.oscillateOff',
        method: 'setOscillating',
        label: t('Stop oscillating', 'Oscillazione spenta'),
        phrase: t('Stop {device} oscillating', 'Ferma l’oscillazione di {device}'),
        icon: 'move-horizontal',
        args: { oscillating: false },
      },
    ],
    state: [
      {
        kind: 'numeric',
        field: 'speed',
        quantity: t('the speed', 'la velocità'),
        label: t('Speed', 'Velocità'),
        unit: '%',
        icon: 'fan',
      },
      {
        kind: 'boolean',
        field: 'oscillating',
        label: t('Oscillating', 'Oscillazione'),
        whenTrue: t('When {device} starts oscillating', 'Quando {device} inizia a oscillare'),
        whenFalse: t('When {device} stops oscillating', 'Quando {device} smette di oscillare'),
        icon: 'move-horizontal',
      },
    ],
  },

  humidifier: {
    scope: 'device',
    noun: t('Humidifier', 'Umidificatore'),
    actions: [
      {
        id: 'humidifier.on',
        method: 'setOn',
        label: t('Humidifier on', 'Umidificatore acceso'),
        phrase: t('Turn on {device}', 'Accendi {device}'),
        icon: 'power',
        args: { on: true },
      },
      {
        id: 'humidifier.off',
        method: 'setOn',
        label: t('Humidifier off', 'Umidificatore spento'),
        phrase: t('Turn off {device}', 'Spegni {device}'),
        icon: 'power-off',
        args: { on: false },
      },
      {
        id: 'humidifier.target',
        method: 'setTargetHumidity',
        label: t('Set humidity', 'Imposta l’umidità'),
        phrase: t(
          'Set {device} to {humidity} humidity',
          'Imposta {device} al {humidity} di umidità',
        ),
        icon: 'droplets',
        openArgs: [
          {
            key: 'humidity',
            label: t('Humidity', 'Umidità'),
            offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
          },
        ],
      },
      {
        id: 'humidifier.mode',
        method: 'setMode',
        label: t('Set mode', 'Imposta la modalità'),
        phrase: t('Set {device} to {mode}', 'Imposta {device} su {mode}'),
        icon: 'list',
        openArgs: [
          {
            key: 'mode',
            label: t('Mode', 'Modalità'),
            offer: { kind: 'dynamic', from: 'status', field: 'availableModes' },
          },
        ],
      },
    ],
    state: [
      {
        kind: 'boolean',
        field: 'on',
        label: ON,
        whenTrue: t('When {device} turns on', 'Quando {device} si accende'),
        whenFalse: t('When {device} turns off', 'Quando {device} si spegne'),
        icon: 'power',
      },
      {
        kind: 'numeric',
        field: 'currentHumidity',
        quantity: t('the humidity', 'l’umidità'),
        label: t('Humidity', 'Umidità'),
        unit: '%',
        icon: 'droplets',
      },
    ],
  },

  'water-heater': {
    scope: 'device',
    noun: t('Water heater', 'Scaldacqua'),
    actions: [
      {
        id: 'waterHeater.off',
        method: 'setOperationMode',
        label: t('Water heater off', 'Scaldacqua spento'),
        phrase: t('Turn off {device}', 'Spegni {device}'),
        icon: 'power-off',
        args: { mode: 'off' },
      },
      {
        id: 'waterHeater.mode',
        method: 'setOperationMode',
        label: t('Set mode', 'Imposta la modalità'),
        phrase: t('Set {device} to {mode}', 'Imposta {device} su {mode}'),
        icon: 'list',
        openArgs: [
          {
            key: 'mode',
            label: t('Mode', 'Modalità'),
            offer: { kind: 'dynamic', from: 'status', field: 'availableModes' },
          },
        ],
      },
      {
        id: 'waterHeater.awayOn',
        method: 'setAway',
        label: t('Water heater away on', 'Scaldacqua in modalità assenza'),
        phrase: t('Put {device} in away mode', 'Metti {device} in modalità assenza'),
        icon: 'plane',
        args: { on: true },
      },
      {
        id: 'waterHeater.awayOff',
        method: 'setAway',
        label: t('Water heater away off', 'Scaldacqua fuori dalla modalità assenza'),
        phrase: t('Take {device} out of away mode', 'Togli {device} dalla modalità assenza'),
        icon: 'house',
        args: { on: false },
      },
      {
        id: 'waterHeater.target',
        method: 'setTargetTemp',
        label: t('Set temperature', 'Imposta la temperatura'),
        phrase: t('Heat the water of {device} to {temp}', 'Scalda l’acqua di {device} a {temp}'),
        icon: 'thermometer',
        openArgs: [
          {
            key: 'temp',
            label: t('Temperature', 'Temperatura'),
            offer: { kind: 'number', step: 1, unit: '°C' },
          },
        ],
      },
    ],
    state: [
      {
        kind: 'numeric',
        field: 'currentTemp',
        quantity: t('the water temperature', 'la temperatura dell’acqua'),
        label: t('Water temperature', 'Temperatura dell’acqua'),
        unit: '°C',
        icon: 'thermometer',
      },
      {
        kind: 'boolean',
        field: 'away',
        label: t('Away mode', 'Modalità assenza'),
        whenTrue: t(
          'When {device} goes into away mode',
          'Quando {device} entra in modalità assenza',
        ),
        whenFalse: t(
          'When {device} leaves away mode',
          'Quando {device} esce dalla modalità assenza',
        ),
        icon: 'plane',
      },
      {
        kind: 'value',
        field: 'operationMode',
        label: t('Mode', 'Modalità'),
        offer: { kind: 'dynamic', from: 'status', field: 'availableModes' },
        icon: 'list',
      },
    ],
  },

  'heating-valve': {
    scope: 'device',
    noun: t('Radiator valve', 'Valvola termostatica'),
    state: [
      {
        kind: 'numeric',
        field: 'position',
        quantity: t('the valve opening', 'l’apertura della valvola'),
        label: t('Valve opening', 'Apertura della valvola'),
        unit: '%',
        icon: 'heater',
      },
    ],
  },

  'alarm-panel': {
    scope: 'device',
    noun: t('Alarm panel', 'Centrale d’allarme'),
    actions: [
      {
        id: 'alarm.trigger',
        method: 'trigger',
        label: t('Trigger alarm', 'Fai scattare l’allarme'),
        phrase: t('Trigger the alarm on {device}', 'Fai scattare l’allarme su {device}'),
        icon: 'siren',
      },
      {
        id: 'alarm.disarm',
        method: 'disarm',
        label: t('Disarm', 'Disinserisci'),
        phrase: t('Disarm {device}', 'Disinserisci {device}'),
        icon: 'shield-off',
        openArgs: [
          {
            key: 'code',
            label: t('PIN code', 'Codice PIN'),
            offer: { kind: 'text', secret: true },
            optional: true,
          },
        ],
      },
      {
        id: 'alarm.arm.home',
        method: 'arm',
        label: t('Arm home', 'Inserisci in casa'),
        phrase: t('Arm {device} for home', 'Inserisci {device} in modalità casa'),
        icon: 'house',
        args: { mode: 'home' },
        openArgs: [
          {
            key: 'code',
            label: t('PIN code', 'Codice PIN'),
            offer: { kind: 'text', secret: true },
            optional: true,
          },
        ],
      },
      {
        id: 'alarm.arm.away',
        method: 'arm',
        label: t('Arm away', 'Inserisci fuori casa'),
        phrase: t('Arm {device} for away', 'Inserisci {device} in modalità fuori casa'),
        icon: 'shield-check',
        args: { mode: 'away' },
        openArgs: [
          {
            key: 'code',
            label: t('PIN code', 'Codice PIN'),
            offer: { kind: 'text', secret: true },
            optional: true,
          },
        ],
      },
      {
        id: 'alarm.arm.night',
        method: 'arm',
        label: t('Arm night', 'Inserisci notte'),
        phrase: t('Arm {device} for the night', 'Inserisci {device} in modalità notte'),
        icon: 'moon',
        args: { mode: 'night' },
        openArgs: [
          {
            key: 'code',
            label: t('PIN code', 'Codice PIN'),
            offer: { kind: 'text', secret: true },
            optional: true,
          },
        ],
      },
      {
        id: 'alarm.arm.vacation',
        method: 'arm',
        label: t('Arm vacation', 'Inserisci vacanza'),
        phrase: t('Arm {device} for vacation', 'Inserisci {device} in modalità vacanza'),
        icon: 'plane',
        args: { mode: 'vacation' },
        openArgs: [
          {
            key: 'code',
            label: t('PIN code', 'Codice PIN'),
            offer: { kind: 'text', secret: true },
            optional: true,
          },
        ],
      },
      {
        id: 'alarm.arm.custom_bypass',
        method: 'arm',
        label: t('Arm custom bypass', 'Inserisci con esclusioni'),
        phrase: t('Arm {device} with its custom bypass', 'Inserisci {device} con le zone escluse'),
        icon: 'shield-half',
        args: { mode: 'custom_bypass' },
        openArgs: [
          {
            key: 'code',
            label: t('PIN code', 'Codice PIN'),
            offer: { kind: 'text', secret: true },
            optional: true,
          },
        ],
      },
    ],
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('Alarm state', 'Stato dell’allarme'),
        values: [
          {
            value: 'disarmed',
            label: t('Disarmed', 'Disinserito'),
            phrase: t('When {device} is disarmed', 'Quando {device} viene disinserito'),
          },
          {
            value: 'armed_home',
            label: t('Armed home', 'Inserito in casa'),
            phrase: t(
              'When {device} is armed for home',
              'Quando {device} viene inserito in modalità casa',
            ),
          },
          {
            value: 'armed_away',
            label: t('Armed away', 'Inserito fuori casa'),
            phrase: t(
              'When {device} is armed for away',
              'Quando {device} viene inserito in modalità fuori casa',
            ),
          },
          {
            value: 'armed_night',
            label: t('Armed night', 'Inserito notte'),
            phrase: t(
              'When {device} is armed for the night',
              'Quando {device} viene inserito in modalità notte',
            ),
          },
          {
            value: 'armed_vacation',
            label: t('Armed vacation', 'Inserito vacanza'),
          },
          {
            value: 'armed_custom_bypass',
            label: t('Armed with bypass', 'Inserito con esclusioni'),
          },
          { value: 'arming', label: t('Arming', 'In inserimento') },
          { value: 'disarming', label: t('Disarming', 'In disinserimento') },
          { value: 'pending', label: t('Entry delay', 'Ritardo d’ingresso') },
          {
            value: 'triggered',
            label: t('Triggered', 'In allarme'),
            phrase: t('When {device} goes off', 'Quando {device} scatta'),
          },
        ],
        icon: 'shield',
      },
    ],
  },

  button: {
    scope: 'device',
    noun: t('Button', 'Pulsante'),
    actions: [
      {
        id: 'button.press',
        method: 'press',
        label: t('Press', 'Premi'),
        phrase: t('Press {device}', 'Premi {device}'),
        icon: 'circle-dot',
      },
    ],
  },

  control: {
    scope: 'device',
    noun: t('Control', 'Controllo'),
    notOperatorFacing: {
      setValue:
        'the value shape depends on the control kind (numeric / select / text / datetime) read from status; a typed picker for it is a follow-up of the automations rework',
    },
    state: [
      {
        kind: 'value',
        field: 'value',
        label: t('Value', 'Valore'),
        offer: { kind: 'dynamic', from: 'status', field: 'options' },
        icon: 'sliders-horizontal',
      },
    ],
  },

  'motion-trigger': {
    scope: 'device',
    noun: t('Motion trigger', 'Attivazione al movimento'),
    actions: [
      {
        id: 'motionTrigger.on',
        method: 'setMotionTrigger',
        label: t('Motion trigger on', 'Attivazione al movimento attiva'),
        phrase: t('Let motion trigger {device}', 'Fai attivare {device} dal movimento'),
        icon: 'activity',
        args: { enabled: true },
      },
      {
        id: 'motionTrigger.off',
        method: 'setMotionTrigger',
        label: t('Motion trigger off', 'Attivazione al movimento spenta'),
        phrase: t('Stop motion triggering {device}', 'Non far più attivare {device} dal movimento'),
        icon: 'activity',
        args: { enabled: false },
      },
    ],
    state: [
      {
        kind: 'boolean',
        field: 'enabled',
        label: t('Motion trigger', 'Attivazione al movimento'),
        whenTrue: t(
          'When motion triggering is turned on for {device}',
          'Quando si attiva l’attivazione al movimento di {device}',
        ),
        whenFalse: t(
          'When motion triggering is turned off for {device}',
          'Quando si disattiva l’attivazione al movimento di {device}',
        ),
        icon: 'activity',
      },
    ],
    events: {
      onMotionTriggerChanged: {
        notOperatorFacing: 'the `enabled` state trigger phrases both edges of this change',
      },
    },
  },
}
