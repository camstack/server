/**
 * Home Assistant MQTT discovery payloads in the shape zigbee2mqtt publishes
 * (JSON state topics, `value_template`, availability lists with the bridge,
 * `device` blocks). Invented ids and names; one entry = one retained message.
 */

export interface DiscoveryMessage {
  readonly component: string
  readonly objectId: string
  readonly payload: Record<string, unknown>
}

function device(ieee: string, name: string, manufacturer: string, model: string) {
  return {
    identifiers: [`zigbee2mqtt_${ieee}`],
    manufacturer,
    model,
    name,
    sw_version: 'Zigbee2MQTT 2.1.0',
    via_device: 'zigbee2mqtt_bridge_0x00124b0000aabbcc',
  }
}

function availability(friendly: string) {
  return {
    availability: [
      { topic: 'zigbee2mqtt/bridge/state', value_template: '{{ value_json.state }}' },
      { topic: `zigbee2mqtt/${friendly}/availability`, value_template: '{{ value_json.state }}' },
    ],
    availability_mode: 'all',
  }
}

export const PLUG_FRIENDLY = 'Kitchen plug'
export const PLUG_IEEE = '0x00158d0001a2b3c4'

/** A metered plug: switch + power / energy / voltage / current + link quality. */
export function plugMessages(): readonly DiscoveryMessage[] {
  const ieee = PLUG_IEEE
  const friendly = PLUG_FRIENDLY
  const topic = `zigbee2mqtt/${friendly}`
  const base = {
    ...availability(friendly),
    device: device(ieee, friendly, 'Acme', 'Smart plug (with power monitoring)'),
    state_topic: topic,
    json_attributes_topic: topic,
  }
  return [
    {
      component: 'switch',
      objectId: `${ieee}_switch`,
      payload: {
        ...base,
        name: null,
        command_topic: `${topic}/set/state`,
        payload_on: 'ON',
        payload_off: 'OFF',
        state_on: 'ON',
        state_off: 'OFF',
        value_template: '{{ value_json.state }}',
        device_class: 'outlet',
        unique_id: `${ieee}_switch_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_power`,
      payload: {
        ...base,
        name: 'Power',
        device_class: 'power',
        state_class: 'measurement',
        unit_of_measurement: 'W',
        value_template: '{{ value_json.power }}',
        unique_id: `${ieee}_power_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_energy`,
      payload: {
        ...base,
        name: 'Energy',
        device_class: 'energy',
        state_class: 'total_increasing',
        unit_of_measurement: 'kWh',
        value_template: '{{ value_json.energy }}',
        unique_id: `${ieee}_energy_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_voltage`,
      payload: {
        ...base,
        name: 'Voltage',
        device_class: 'voltage',
        state_class: 'measurement',
        unit_of_measurement: 'V',
        value_template: '{{ value_json.voltage }}',
        unique_id: `${ieee}_voltage_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_current`,
      payload: {
        ...base,
        name: 'Current',
        device_class: 'current',
        state_class: 'measurement',
        unit_of_measurement: 'A',
        value_template: '{{ value_json.current }}',
        unique_id: `${ieee}_current_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_linkquality`,
      payload: {
        ...base,
        name: 'Linkquality',
        entity_category: 'diagnostic',
        enabled_by_default: false,
        state_class: 'measurement',
        unit_of_measurement: 'lqi',
        value_template: '{{ value_json.linkquality }}',
        unique_id: `${ieee}_linkquality_zigbee2mqtt`,
      },
    },
    {
      component: 'update',
      objectId: `${ieee}_update`,
      payload: {
        ...base,
        name: null,
        device_class: 'firmware',
        unique_id: `${ieee}_update_zigbee2mqtt`,
      },
    },
  ]
}

export const BULB_IEEE = '0x00178801022a3b4c'
export const BULB_FRIENDLY = 'Hall bulb'

/** A dimmable colour-temperature bulb (JSON light schema). */
export function bulbMessages(): readonly DiscoveryMessage[] {
  const ieee = BULB_IEEE
  const friendly = BULB_FRIENDLY
  const topic = `zigbee2mqtt/${friendly}`
  const base = {
    ...availability(friendly),
    device: device(ieee, friendly, 'Acme', 'White ambiance bulb E27'),
  }
  return [
    {
      component: 'light',
      objectId: `${ieee}_light`,
      payload: {
        ...base,
        name: null,
        schema: 'json',
        state_topic: topic,
        command_topic: `${topic}/set`,
        brightness: true,
        brightness_scale: 254,
        color_mode: true,
        supported_color_modes: ['color_temp'],
        min_mireds: 153,
        max_mireds: 500,
        effect: true,
        effect_list: ['blink', 'breathe'],
        unique_id: `${ieee}_light_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_linkquality`,
      payload: {
        ...base,
        name: 'Linkquality',
        entity_category: 'diagnostic',
        state_topic: topic,
        unit_of_measurement: 'lqi',
        value_template: '{{ value_json.linkquality }}',
        unique_id: `${ieee}_linkquality_zigbee2mqtt`,
      },
    },
  ]
}

export const CONTACT_IEEE = '0x00158d0002c4d5e6'
export const CONTACT_FRIENDLY = 'Front door'

/** A door / window contact sensor with a battery. */
export function contactMessages(): readonly DiscoveryMessage[] {
  const ieee = CONTACT_IEEE
  const friendly = CONTACT_FRIENDLY
  const topic = `zigbee2mqtt/${friendly}`
  const base = {
    ...availability(friendly),
    device: device(ieee, friendly, 'Acme', 'Door and window sensor'),
    state_topic: topic,
  }
  return [
    {
      component: 'binary_sensor',
      objectId: `${ieee}_contact`,
      payload: {
        ...base,
        name: 'Contact',
        device_class: 'door',
        payload_on: false,
        payload_off: true,
        value_template: '{{ value_json.contact }}',
        unique_id: `${ieee}_contact_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_battery`,
      payload: {
        ...base,
        name: 'Battery',
        device_class: 'battery',
        entity_category: 'diagnostic',
        state_class: 'measurement',
        unit_of_measurement: '%',
        value_template: '{{ value_json.battery }}',
        unique_id: `${ieee}_battery_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_voltage`,
      payload: {
        ...base,
        name: 'Voltage',
        device_class: 'voltage',
        entity_category: 'diagnostic',
        unit_of_measurement: 'mV',
        value_template: '{{ value_json.voltage }}',
        unique_id: `${ieee}_voltage_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_linkquality`,
      payload: {
        ...base,
        name: 'Linkquality',
        entity_category: 'diagnostic',
        unit_of_measurement: 'lqi',
        value_template: '{{ value_json.linkquality }}',
        unique_id: `${ieee}_linkquality_zigbee2mqtt`,
      },
    },
  ]
}

export const MOTION_IEEE = '0x00158d0003f7a8b9'
export const MOTION_FRIENDLY = 'Corridor motion'

/** A motion / occupancy sensor with illuminance, temperature and battery. */
export function motionMessages(): readonly DiscoveryMessage[] {
  const ieee = MOTION_IEEE
  const friendly = MOTION_FRIENDLY
  const topic = `zigbee2mqtt/${friendly}`
  const base = {
    ...availability(friendly),
    device: device(ieee, friendly, 'Acme', 'Motion sensor with illuminance'),
    state_topic: topic,
  }
  return [
    {
      component: 'binary_sensor',
      objectId: `${ieee}_occupancy`,
      payload: {
        ...base,
        name: 'Occupancy',
        device_class: 'occupancy',
        payload_on: true,
        payload_off: false,
        value_template: '{{ value_json.occupancy }}',
        unique_id: `${ieee}_occupancy_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_illuminance`,
      payload: {
        ...base,
        name: 'Illuminance',
        device_class: 'illuminance',
        state_class: 'measurement',
        unit_of_measurement: 'lx',
        value_template: '{{ value_json.illuminance }}',
        unique_id: `${ieee}_illuminance_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_temperature`,
      payload: {
        ...base,
        name: 'Temperature',
        device_class: 'temperature',
        state_class: 'measurement',
        unit_of_measurement: '°C',
        value_template: '{{ value_json.temperature }}',
        unique_id: `${ieee}_temperature_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_battery`,
      payload: {
        ...base,
        name: 'Battery',
        device_class: 'battery',
        entity_category: 'diagnostic',
        unit_of_measurement: '%',
        value_template: '{{ value_json.battery }}',
        unique_id: `${ieee}_battery_zigbee2mqtt`,
      },
    },
  ]
}

export const TRV_IEEE = '0x00124b0004b1c2d3'
export const TRV_FRIENDLY = 'Bedroom valve'

/** A radiator valve: climate entity plus battery. */
export function thermostatMessages(): readonly DiscoveryMessage[] {
  const ieee = TRV_IEEE
  const friendly = TRV_FRIENDLY
  const topic = `zigbee2mqtt/${friendly}`
  const base = {
    ...availability(friendly),
    device: device(ieee, friendly, 'Acme', 'Radiator valve'),
  }
  return [
    {
      component: 'climate',
      objectId: `${ieee}_climate`,
      payload: {
        ...base,
        name: null,
        current_temperature_topic: topic,
        current_temperature_template: '{{ value_json.local_temperature }}',
        temperature_state_topic: topic,
        temperature_state_template: '{{ value_json.occupied_heating_setpoint }}',
        temperature_command_topic: `${topic}/set/occupied_heating_setpoint`,
        mode_state_topic: topic,
        mode_state_template: '{{ value_json.system_mode }}',
        mode_command_topic: `${topic}/set/system_mode`,
        modes: ['off', 'auto', 'heat'],
        min_temp: 5,
        max_temp: 30,
        temp_step: 0.5,
        temperature_unit: 'C',
        unique_id: `${ieee}_climate_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_battery`,
      payload: {
        ...base,
        name: 'Battery',
        device_class: 'battery',
        entity_category: 'diagnostic',
        state_topic: topic,
        unit_of_measurement: '%',
        value_template: '{{ value_json.battery }}',
        unique_id: `${ieee}_battery_zigbee2mqtt`,
      },
    },
  ]
}

export const REMOTE_IEEE = '0x00158d0005d4e5f6'
export const REMOTE_FRIENDLY = 'Bedside remote'

/** A scene remote: an `event` entity plus battery. */
export function remoteMessages(): readonly DiscoveryMessage[] {
  const ieee = REMOTE_IEEE
  const friendly = REMOTE_FRIENDLY
  const topic = `zigbee2mqtt/${friendly}`
  const base = {
    ...availability(friendly),
    device: device(ieee, friendly, 'Acme', 'Wireless scene remote'),
  }
  return [
    {
      component: 'event',
      objectId: `${ieee}_action`,
      payload: {
        ...base,
        name: 'Action',
        state_topic: `${topic}/action`,
        event_types: ['single', 'double', 'hold'],
        device_class: 'button',
        value_template: '{"event_type": "{{ value_json.event_type }}"}',
        unique_id: `${ieee}_action_zigbee2mqtt`,
      },
    },
    {
      component: 'sensor',
      objectId: `${ieee}_battery`,
      payload: {
        ...base,
        name: 'Battery',
        device_class: 'battery',
        entity_category: 'diagnostic',
        state_topic: topic,
        unit_of_measurement: '%',
        value_template: '{{ value_json.battery }}',
        unique_id: `${ieee}_battery_zigbee2mqtt`,
      },
    },
  ]
}

export const TRIGGER_REMOTE_IEEE = '0x00158d0007a8b9c0'
export const TRIGGER_REMOTE_FRIENDLY = 'Hall remote'

/** One device trigger, as a bridge publishes it the first time the action occurs. */
export function triggerMessage(action: string): DiscoveryMessage {
  return {
    component: 'device_automation',
    objectId: `action_${action}`,
    payload: {
      automation_type: 'trigger',
      type: 'action',
      subtype: action,
      payload: action,
      topic: `zigbee2mqtt/${TRIGGER_REMOTE_FRIENDLY}/action`,
      device: device(TRIGGER_REMOTE_IEEE, TRIGGER_REMOTE_FRIENDLY, 'Acme', 'Wireless remote'),
    },
  }
}

/** A remote with no `event` entity: its buttons are device triggers, plus battery. */
export function triggerRemoteMessages(): readonly DiscoveryMessage[] {
  const ieee = TRIGGER_REMOTE_IEEE
  const friendly = TRIGGER_REMOTE_FRIENDLY
  return [
    {
      component: 'sensor',
      objectId: `${ieee}_battery`,
      payload: {
        ...availability(friendly),
        device: device(ieee, friendly, 'Acme', 'Wireless remote'),
        name: 'Battery',
        device_class: 'battery',
        entity_category: 'diagnostic',
        state_topic: `zigbee2mqtt/${friendly}`,
        unit_of_measurement: '%',
        value_template: '{{ value_json.battery }}',
        unique_id: `${ieee}_battery_zigbee2mqtt`,
      },
    },
    triggerMessage('single'),
    triggerMessage('double'),
    triggerMessage('hold'),
  ]
}

export const IR_IEEE = '0xa4c138000000abcd'
export const IR_FRIENDLY = 'Living room IR'
export const IR_TOPIC = `zigbee2mqtt/${IR_FRIENDLY}`
export const IR_ORIGIN = {
  name: 'Zigbee2MQTT',
  sw: '2.1.0',
  url: 'https://www.zigbee2mqtt.io',
}

/**
 * A Tuya IR blaster (zosung family) as zigbee2mqtt publishes it: a SET-only
 * text for the code to send, a SET-only select that starts learning, and a
 * sensor whose string state is the last learned code. Each carries `origin`.
 */
export interface IrBlasterOptions {
  /** Command topics as the discovery payloads announce them (default `<base>/set/<property>`). */
  readonly sendTopic?: string
  readonly learnTopic?: string
  /** A `command_template` on the code entity. */
  readonly sendTemplate?: string
  /** An extra temperature sensor and battery on the same physical device. */
  readonly withReadings?: boolean
}

export function irBlasterMessages(options: IrBlasterOptions = {}): readonly DiscoveryMessage[] {
  const base = {
    ...availability(IR_FRIENDLY),
    device: device(IR_IEEE, IR_FRIENDLY, 'Acme', 'IR remote blaster'),
    origin: IR_ORIGIN,
  }
  return [
    {
      component: 'text',
      objectId: `${IR_IEEE}_ir_code_to_send`,
      payload: {
        ...base,
        name: 'IR code to send',
        unique_id: `${IR_IEEE}_ir_code_to_send_zigbee2mqtt`,
        command_topic: options.sendTopic ?? `${IR_TOPIC}/set/ir_code_to_send`,
        ...(options.sendTemplate === undefined ? {} : { command_template: options.sendTemplate }),
        entity_category: 'config',
      },
    },
    {
      component: 'select',
      objectId: `${IR_IEEE}_learn_ir_code`,
      payload: {
        ...base,
        name: 'Learn IR code',
        unique_id: `${IR_IEEE}_learn_ir_code_zigbee2mqtt`,
        command_topic: options.learnTopic ?? `${IR_TOPIC}/set/learn_ir_code`,
        state_topic: IR_TOPIC,
        value_template: '{{ value_json.learn_ir_code }}',
        options: ['ON', 'OFF'],
        entity_category: 'config',
      },
    },
    {
      component: 'sensor',
      objectId: `${IR_IEEE}_learned_ir_code`,
      payload: {
        ...base,
        name: 'Learned IR code',
        unique_id: `${IR_IEEE}_learned_ir_code_zigbee2mqtt`,
        state_topic: IR_TOPIC,
        value_template: '{{ value_json.learned_ir_code }}',
        entity_category: 'diagnostic',
      },
    },
    ...(options.withReadings === true
      ? [
          {
            component: 'sensor' as const,
            objectId: `${IR_IEEE}_temperature`,
            payload: {
              ...base,
              name: 'Temperature',
              device_class: 'temperature',
              unit_of_measurement: '°C',
              state_topic: IR_TOPIC,
              value_template: '{{ value_json.temperature }}',
              unique_id: `${IR_IEEE}_temperature_zigbee2mqtt`,
            },
          },
          {
            component: 'sensor' as const,
            objectId: `${IR_IEEE}_battery`,
            payload: {
              ...base,
              name: 'Battery',
              device_class: 'battery',
              unit_of_measurement: '%',
              state_topic: IR_TOPIC,
              value_template: '{{ value_json.battery }}',
              unique_id: `${IR_IEEE}_battery_zigbee2mqtt`,
            },
          },
        ]
      : []),
  ]
}
