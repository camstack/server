/**
 * Things an operator WATCHES: contacts, motion, leaks, smoke, measurements,
 * presence, reachability, batteries, doorbells and event sources.
 */
import { EventCategory } from '../../../enums/event-category.js'
import { DeviceRole } from '../../device-type.js'
import { t } from '../l10n.js'
import type { CapVocabularySlice } from '../types.js'

type SensorCap =
  | 'air-quality-sensor'
  | 'ambient-light-sensor'
  | 'binary'
  | 'carbon-monoxide'
  | 'connectivity'
  | 'contact'
  | 'enum-sensor'
  | 'flood'
  | 'gas'
  | 'group-status'
  | 'humidity-sensor'
  | 'motion'
  | 'numeric-sensor'
  | 'power-meter'
  | 'presence'
  | 'pressure-sensor'
  | 'smoke'
  | 'tamper'
  | 'temperature-sensor'
  | 'vibration'
  | 'weather'
  | 'battery'
  | 'network-link'
  | 'device-status'
  | 'doorbell'
  | 'event-emitter'

const DETECTED = t('Detected', 'Rilevato')

/** The sensor family of the vocabulary. */
export const SENSOR_CAP_VOCABULARY: CapVocabularySlice<SensorCap> = {
  'air-quality-sensor': {
    scope: 'device',
    noun: t('Air quality', 'Qualità dell’aria'),
    state: [
      {
        kind: 'numeric',
        field: 'co2Ppm',
        quantity: t('the CO₂', 'la CO₂'),
        label: t('CO₂', 'CO₂'),
        unit: 'ppm',
        icon: 'wind',
      },
      {
        kind: 'numeric',
        field: 'vocPpb',
        quantity: t('the VOC level', 'il livello di COV'),
        label: t('VOC', 'COV'),
        unit: 'ppb',
        icon: 'wind',
      },
      {
        kind: 'numeric',
        field: 'pm25',
        quantity: t('the PM2.5', 'il PM2,5'),
        label: t('PM2.5', 'PM2,5'),
        unit: 'µg/m³',
        icon: 'cloud-fog',
      },
      {
        kind: 'numeric',
        field: 'pm10',
        quantity: t('the PM10', 'il PM10'),
        label: t('PM10', 'PM10'),
        unit: 'µg/m³',
        icon: 'cloud-fog',
      },
      {
        kind: 'numeric',
        field: 'aqi',
        quantity: t('the air quality index', 'l’indice di qualità dell’aria'),
        label: t('AQI', 'IQA'),
        icon: 'wind',
      },
    ],
  },

  'ambient-light-sensor': {
    scope: 'device',
    noun: t('Light level', 'Luminosità ambiente'),
    state: [
      {
        kind: 'numeric',
        field: 'lux',
        quantity: t('the light level', 'la luminosità'),
        label: t('Illuminance', 'Illuminamento'),
        unit: 'lx',
        icon: 'sun',
      },
    ],
  },

  binary: {
    scope: 'device',
    noun: t('Binary sensor', 'Sensore binario'),
    state: [
      {
        kind: 'boolean',
        field: 'on',
        label: t('On', 'Acceso'),
        whenTrue: t('When {device} turns active', 'Quando {device} si attiva'),
        whenFalse: t('When {device} turns inactive', 'Quando {device} si disattiva'),
        icon: 'toggle-right',
      },
    ],
    overrides: {
      byRole: {
        [DeviceRole.MotionSensor]: {
          state: {
            on: {
              label: t('Motion', 'Movimento'),
              whenTrue: t('When {device} detects motion', 'Quando {device} rileva movimento'),
              whenFalse: t(
                'When motion clears on {device}',
                'Quando il movimento su {device} cessa',
              ),
              icon: 'activity',
            },
          },
        },
        [DeviceRole.ContactSensor]: {
          state: {
            on: {
              label: t('Open', 'Aperto'),
              whenTrue: t('When {device} opens', 'Quando {device} si apre'),
              whenFalse: t('When {device} closes', 'Quando {device} si chiude'),
              icon: 'door-open',
            },
          },
        },
        [DeviceRole.LeakSensor]: {
          state: {
            on: {
              label: t('Leak', 'Perdita'),
              whenTrue: t('When {device} detects a leak', 'Quando {device} rileva una perdita'),
              whenFalse: t('When {device} is dry again', 'Quando {device} torna asciutto'),
              icon: 'droplets',
            },
          },
        },
        [DeviceRole.SmokeSensor]: {
          state: {
            on: {
              label: t('Smoke', 'Fumo'),
              whenTrue: t('When {device} detects smoke', 'Quando {device} rileva fumo'),
              whenFalse: t('When smoke clears on {device}', 'Quando il fumo su {device} si dirada'),
              icon: 'alarm-smoke',
            },
          },
        },
        [DeviceRole.COSensor]: {
          state: {
            on: {
              label: t('Carbon monoxide', 'Monossido di carbonio'),
              whenTrue: t(
                'When {device} detects carbon monoxide',
                'Quando {device} rileva monossido di carbonio',
              ),
              whenFalse: t(
                'When the carbon monoxide clears on {device}',
                'Quando il monossido su {device} rientra',
              ),
              icon: 'cloud-alert',
            },
          },
        },
        [DeviceRole.GasSensor]: {
          state: {
            on: {
              label: t('Gas', 'Gas'),
              whenTrue: t('When {device} detects gas', 'Quando {device} rileva gas'),
              whenFalse: t('When the gas clears on {device}', 'Quando il gas su {device} rientra'),
              icon: 'flame',
            },
          },
        },
        [DeviceRole.TamperSensor]: {
          state: {
            on: {
              label: t('Tampered', 'Manomesso'),
              whenTrue: t('When {device} is tampered with', 'Quando {device} viene manomesso'),
              whenFalse: t(
                'When the tamper alert on {device} clears',
                'Quando l’allarme di manomissione di {device} rientra',
              ),
              icon: 'shield-alert',
            },
          },
        },
        [DeviceRole.VibrationSensor]: {
          state: {
            on: {
              label: t('Vibration', 'Vibrazione'),
              whenTrue: t('When {device} vibrates', 'Quando {device} vibra'),
              whenFalse: t('When {device} is still again', 'Quando {device} torna fermo'),
              icon: 'vibrate',
            },
          },
        },
        [DeviceRole.ConnectivitySensor]: {
          state: {
            on: {
              label: t('Connected', 'Connesso'),
              whenTrue: t('When {device} connects', 'Quando {device} si connette'),
              whenFalse: t('When {device} disconnects', 'Quando {device} si disconnette'),
              icon: 'wifi',
            },
          },
        },
        [DeviceRole.SoundSensor]: {
          state: {
            on: {
              label: t('Sound', 'Suono'),
              whenTrue: t('When {device} hears a sound', 'Quando {device} sente un suono'),
              whenFalse: t('When {device} is quiet again', 'Quando {device} torna silenzioso'),
              icon: 'ear',
            },
          },
        },
        [DeviceRole.BatterySensor]: {
          state: {
            on: {
              label: t('Battery low', 'Batteria scarica'),
              whenTrue: t(
                'When the battery of {device} runs low',
                'Quando la batteria di {device} si scarica',
              ),
              whenFalse: t(
                'When the battery of {device} is fine again',
                'Quando la batteria di {device} torna a posto',
              ),
              icon: 'battery-low',
            },
          },
        },
        [DeviceRole.BinaryHelper]: {
          state: {
            on: {
              label: t('On', 'Acceso'),
              whenTrue: t('When {device} turns on', 'Quando {device} si accende'),
              whenFalse: t('When {device} turns off', 'Quando {device} si spegne'),
              icon: 'toggle-right',
            },
          },
        },
      },
    },
  },

  'carbon-monoxide': {
    scope: 'device',
    noun: t('Carbon monoxide', 'Monossido di carbonio'),
    state: [
      {
        kind: 'boolean',
        field: 'detected',
        label: DETECTED,
        whenTrue: t(
          'When {device} detects carbon monoxide',
          'Quando {device} rileva monossido di carbonio',
        ),
        whenFalse: t(
          'When the carbon monoxide clears on {device}',
          'Quando il monossido su {device} rientra',
        ),
        icon: 'cloud-alert',
      },
    ],
  },

  connectivity: {
    scope: 'device',
    noun: t('Connectivity', 'Connettività'),
    state: [
      {
        kind: 'boolean',
        field: 'connected',
        label: t('Connected', 'Connesso'),
        whenTrue: t('When {device} connects', 'Quando {device} si connette'),
        whenFalse: t('When {device} disconnects', 'Quando {device} si disconnette'),
        icon: 'wifi',
      },
    ],
  },

  contact: {
    scope: 'device',
    noun: t('Contact', 'Contatto'),
    state: [
      {
        kind: 'boolean',
        field: 'entryOpen',
        label: t('Open', 'Aperto'),
        whenTrue: t('When {device} opens', 'Quando {device} si apre'),
        whenFalse: t('When {device} closes', 'Quando {device} si chiude'),
        icon: 'door-open',
      },
    ],
  },

  'enum-sensor': {
    scope: 'device',
    noun: t('State sensor', 'Sensore di stato'),
    state: [
      {
        kind: 'value',
        field: 'value',
        label: t('State', 'Stato'),
        icon: 'list',
      },
    ],
  },

  flood: {
    scope: 'device',
    noun: t('Leak sensor', 'Sensore di allagamento'),
    state: [
      {
        kind: 'boolean',
        field: 'flooded',
        label: t('Leak', 'Perdita'),
        whenTrue: t('When {device} detects a leak', 'Quando {device} rileva una perdita'),
        whenFalse: t('When {device} is dry again', 'Quando {device} torna asciutto'),
        icon: 'droplets',
      },
    ],
  },

  gas: {
    scope: 'device',
    noun: t('Gas sensor', 'Sensore di gas'),
    state: [
      {
        kind: 'boolean',
        field: 'detected',
        label: DETECTED,
        whenTrue: t('When {device} detects gas', 'Quando {device} rileva gas'),
        whenFalse: t('When the gas clears on {device}', 'Quando il gas su {device} rientra'),
        icon: 'flame',
      },
    ],
  },

  'group-status': {
    scope: 'device',
    noun: t('Group', 'Gruppo'),
    state: [
      {
        kind: 'numeric',
        field: 'included',
        quantity: t('the members reporting', 'i membri che rispondono'),
        label: t('Reporting', 'Rispondono'),
        icon: 'users',
      },
      {
        kind: 'numeric',
        field: 'excluded',
        quantity: t('the members left out', 'i membri esclusi'),
        label: t('Excluded', 'Esclusi'),
        icon: 'users',
      },
      {
        kind: 'numeric',
        field: 'total',
        quantity: t('the member count', 'il numero di membri'),
        label: t('Members', 'Membri'),
        icon: 'sigma',
      },
    ],
  },

  'humidity-sensor': {
    scope: 'device',
    noun: t('Humidity', 'Umidità'),
    state: [
      {
        kind: 'numeric',
        field: 'percent',
        quantity: t('the humidity', 'l’umidità'),
        label: t('Humidity', 'Umidità'),
        unit: '%',
        icon: 'droplets',
      },
    ],
  },

  motion: {
    scope: 'device',
    noun: t('Motion', 'Movimento'),
    state: [
      {
        kind: 'boolean',
        field: 'detected',
        label: t('Motion', 'Movimento'),
        whenTrue: t('When {device} detects motion', 'Quando {device} rileva movimento'),
        whenFalse: t('When motion clears on {device}', 'Quando il movimento su {device} cessa'),
        icon: 'activity',
      },
    ],
    events: {
      onMotionChanged: {
        notOperatorFacing:
          'the `detected` state trigger phrases both edges, from the mirror that survives a dropped event (D49)',
      },
    },
  },

  'numeric-sensor': {
    scope: 'device',
    noun: t('Sensor', 'Sensore'),
    state: [
      {
        kind: 'numeric',
        field: 'value',
        quantity: t('the reading', 'il valore'),
        label: t('Reading', 'Valore'),
        icon: 'gauge',
      },
    ],
  },

  'power-meter': {
    scope: 'device',
    noun: t('Power meter', 'Misuratore di energia'),
    state: [
      {
        kind: 'numeric',
        field: 'watts',
        quantity: t('the power draw', 'il consumo'),
        label: t('Power', 'Potenza'),
        unit: 'W',
        icon: 'zap',
      },
      {
        kind: 'numeric',
        field: 'kwhTotal',
        quantity: t('the energy used', 'l’energia consumata'),
        label: t('Energy', 'Energia'),
        unit: 'kWh',
        icon: 'zap',
      },
      {
        kind: 'numeric',
        field: 'volts',
        quantity: t('the voltage', 'la tensione'),
        label: t('Voltage', 'Tensione'),
        unit: 'V',
        icon: 'zap',
      },
      {
        kind: 'numeric',
        field: 'amps',
        quantity: t('the current', 'la corrente'),
        label: t('Current', 'Corrente'),
        unit: 'A',
        icon: 'zap',
      },
    ],
  },

  presence: {
    scope: 'device',
    noun: t('Presence', 'Presenza'),
    state: [
      {
        kind: 'value',
        field: 'state',
        label: t('Where', 'Posizione'),
        phrase: t('When {device} is at {value}', 'Quando {device} è in {value}'),
        icon: 'map-pin',
      },
      {
        kind: 'numeric',
        field: 'batteryPercent',
        quantity: t('the phone battery', 'la batteria del telefono'),
        label: t('Battery', 'Batteria'),
        unit: '%',
        icon: 'battery',
      },
    ],
  },

  'pressure-sensor': {
    scope: 'device',
    noun: t('Pressure', 'Pressione'),
    state: [
      {
        kind: 'numeric',
        field: 'hpa',
        quantity: t('the pressure', 'la pressione'),
        label: t('Pressure', 'Pressione'),
        unit: 'hPa',
        icon: 'gauge',
      },
    ],
  },

  smoke: {
    scope: 'device',
    noun: t('Smoke detector', 'Rilevatore di fumo'),
    state: [
      {
        kind: 'boolean',
        field: 'detected',
        label: DETECTED,
        whenTrue: t('When {device} detects smoke', 'Quando {device} rileva fumo'),
        whenFalse: t('When smoke clears on {device}', 'Quando il fumo su {device} si dirada'),
        icon: 'alarm-smoke',
      },
    ],
  },

  tamper: {
    scope: 'device',
    noun: t('Tamper', 'Manomissione'),
    state: [
      {
        kind: 'boolean',
        field: 'tampered',
        label: t('Tampered', 'Manomesso'),
        whenTrue: t('When {device} is tampered with', 'Quando {device} viene manomesso'),
        whenFalse: t(
          'When the tamper alert on {device} clears',
          'Quando l’allarme di manomissione di {device} rientra',
        ),
        icon: 'shield-alert',
      },
    ],
  },

  'temperature-sensor': {
    scope: 'device',
    noun: t('Temperature', 'Temperatura'),
    state: [
      {
        kind: 'numeric',
        field: 'celsius',
        quantity: t('the temperature', 'la temperatura'),
        label: t('Temperature', 'Temperatura'),
        unit: '°C',
        icon: 'thermometer',
      },
    ],
  },

  vibration: {
    scope: 'device',
    noun: t('Vibration', 'Vibrazione'),
    state: [
      {
        kind: 'boolean',
        field: 'detected',
        label: t('Vibration', 'Vibrazione'),
        whenTrue: t('When {device} vibrates', 'Quando {device} vibra'),
        whenFalse: t('When {device} is still again', 'Quando {device} torna fermo'),
        icon: 'vibrate',
      },
    ],
  },

  weather: {
    scope: 'device',
    noun: t('Weather', 'Meteo'),
    state: [
      {
        kind: 'value',
        field: 'condition',
        label: t('Conditions', 'Condizioni'),
        phrase: t(
          'When the weather at {device} turns {value}',
          'Quando il meteo di {device} diventa {value}',
        ),
        icon: 'cloud-sun',
      },
      {
        kind: 'numeric',
        field: 'temperature',
        quantity: t('the outdoor temperature', 'la temperatura esterna'),
        label: t('Temperature', 'Temperatura'),
        unit: '°C',
        icon: 'thermometer',
      },
      {
        kind: 'numeric',
        field: 'humidity',
        quantity: t('the outdoor humidity', 'l’umidità esterna'),
        label: t('Humidity', 'Umidità'),
        unit: '%',
        icon: 'droplets',
      },
      {
        kind: 'numeric',
        field: 'windSpeed',
        quantity: t('the wind speed', 'la velocità del vento'),
        label: t('Wind', 'Vento'),
        unit: 'm/s',
        icon: 'wind',
      },
      {
        kind: 'numeric',
        field: 'pressure',
        quantity: t('the air pressure', 'la pressione atmosferica'),
        label: t('Pressure', 'Pressione'),
        unit: 'hPa',
        icon: 'gauge',
      },
    ],
  },

  battery: {
    scope: 'device',
    noun: t('Battery', 'Batteria'),
    notOperatorFacing: {
      wakeForStream:
        'a stream consumer wakes a sleeping camera to watch it; an automation that wants footage asks for the footage',
    },
    state: [
      {
        kind: 'numeric',
        field: 'percentage',
        quantity: t('the battery level', 'il livello della batteria'),
        label: t('Battery', 'Batteria'),
        unit: '%',
        icon: 'battery',
      },
      {
        kind: 'boolean',
        field: 'sleeping',
        label: t('Asleep', 'In sospensione'),
        whenTrue: t('When {device} goes to sleep', 'Quando {device} va in sospensione'),
        whenFalse: t('When {device} wakes up', 'Quando {device} si risveglia'),
        icon: 'moon',
      },
      {
        kind: 'enum',
        field: 'charging',
        label: t('Charging', 'Ricarica'),
        values: [
          {
            value: 'dc',
            label: t('Charging from mains', 'In carica da rete'),
            phrase: t('When {device} starts charging', 'Quando {device} inizia a caricarsi'),
          },
          {
            value: 'solar',
            label: t('Charging from solar', 'In carica dal pannello solare'),
            phrase: t(
              'When {device} charges from its solar panel',
              'Quando {device} si carica dal pannello solare',
            ),
          },
          {
            value: 'none',
            label: t('Not charging', 'Non in carica'),
            phrase: t('When {device} stops charging', 'Quando {device} smette di caricarsi'),
          },
          { value: 'unknown', label: t('Unknown', 'Sconosciuto') },
        ],
        icon: 'battery-charging',
      },
    ],
    events: {
      onStatusChanged: {
        notOperatorFacing:
          'the percentage / sleeping / charging state triggers each read one field of this change',
      },
    },
    extraEvents: [
      {
        category: EventCategory.DeviceAwake,
        label: t('Woke up', 'Risvegliato'),
        phrase: t('When {device} wakes up', 'Quando {device} si risveglia'),
        icon: 'sun',
      },
      {
        category: EventCategory.DeviceSleeping,
        label: t('Went to sleep', 'In sospensione'),
        phrase: t('When {device} goes to sleep', 'Quando {device} va in sospensione'),
        icon: 'moon',
      },
    ],
  },

  'network-link': {
    scope: 'device',
    noun: t('Network link', 'Collegamento di rete'),
    state: [
      {
        kind: 'numeric',
        field: 'signalPercent',
        quantity: t('the signal strength', 'l’intensità del segnale'),
        label: t('Signal', 'Segnale'),
        unit: '%',
        icon: 'wifi',
      },
      {
        kind: 'enum',
        field: 'type',
        label: t('Link type', 'Tipo di collegamento'),
        values: [
          { value: 'wifi', label: t('Wi-Fi', 'Wi-Fi') },
          { value: 'ethernet', label: t('Ethernet', 'Ethernet') },
          { value: 'cellular', label: t('Cellular', 'Rete mobile') },
          { value: 'unknown', label: t('Unknown', 'Sconosciuto') },
        ],
        icon: 'network',
      },
    ],
    events: {
      onStatusChanged: {
        notOperatorFacing:
          'the signal / link-type state triggers each read one field of this change',
      },
    },
  },

  'device-status': {
    scope: 'device',
    noun: t('Reachability', 'Raggiungibilità'),
    state: [
      {
        kind: 'boolean',
        field: 'online',
        label: t('Online', 'Online'),
        whenTrue: t('When {device} comes back online', 'Quando {device} torna online'),
        whenFalse: t('When {device} goes offline', 'Quando {device} va offline'),
        icon: 'wifi',
      },
    ],
    events: {
      onStatusChanged: {
        notOperatorFacing: 'the `online` state trigger phrases both edges of this change',
      },
    },
    extraEvents: [
      {
        category: EventCategory.DeviceOnline,
        label: t('Came online', 'Tornato online'),
        phrase: t('When {device} comes back online', 'Quando {device} torna online'),
        icon: 'wifi',
      },
      {
        category: EventCategory.DeviceOffline,
        label: t('Went offline', 'Andato offline'),
        phrase: t('When {device} goes offline', 'Quando {device} va offline'),
        icon: 'wifi-off',
      },
    ],
  },

  doorbell: {
    scope: 'device',
    noun: t('Doorbell', 'Campanello'),
    events: {
      onPressed: {
        category: EventCategory.DoorbellOnPressed,
        label: t('Rang', 'Ha suonato'),
        phrase: t('When someone rings {device}', 'Quando qualcuno suona a {device}'),
        icon: 'bell-ring',
      },
    },
  },

  'event-emitter': {
    scope: 'device',
    noun: t('Event source', 'Sorgente di eventi'),
    events: {
      onEvent: {
        category: EventCategory.EventEmitted,
        label: t('Fired an event', 'Ha generato un evento'),
        phrase: t('When {device} fires an event', 'Quando {device} genera un evento'),
        icon: 'zap',
      },
    },
  },
}
