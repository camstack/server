import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import { buildDiscoveryCandidates } from '../ha-discovery.js'

describe('buildDiscoveryCandidates', () => {
  const brokerId = 'ha_001'
  const integrationId = 'integration-xyz'

  const devices = [
    {
      id: 'dev-abc',
      name: 'Living Room Hub',
      name_by_user: null,
      manufacturer: 'Aqara',
      model: 'Hub M2',
      sw_version: '1.0',
      hw_version: null,
      area_id: null,
      disabled_by: null,
    },
  ]

  const entities = [
    {
      entity_id: 'cover.garage_door',
      unique_id: 'uid-cover-1',
      device_id: 'dev-abc',
      name: 'Garage Door',
      original_name: 'Garage Door',
      platform: 'homeassistant',
      area_id: null,
      device_class: 'garage',
      original_device_class: 'garage',
      disabled_by: null,
      hidden_by: null,
    },
    {
      entity_id: 'sensor.temperature',
      unique_id: 'uid-sensor-1',
      device_id: 'dev-abc',
      name: 'Temperature',
      original_name: 'Temperature',
      platform: 'homeassistant',
      area_id: null,
      device_class: 'temperature',
      original_device_class: 'temperature',
      disabled_by: null,
      hidden_by: null,
    },
    // Disabled entity — must be skipped (inert in HA, no state).
    {
      entity_id: 'sensor.disabled',
      unique_id: 'uid-sensor-disabled',
      device_id: 'dev-abc',
      name: 'Disabled Sensor',
      original_name: 'Disabled Sensor',
      platform: 'homeassistant',
      area_id: null,
      device_class: 'temperature',
      original_device_class: 'temperature',
      disabled_by: 'user',
      hidden_by: null,
    },
    // Diagnostic entity — captures entity_category.
    {
      entity_id: 'sensor.rssi',
      unique_id: 'uid-sensor-rssi',
      device_id: 'dev-abc',
      name: 'Signal',
      original_name: 'Signal',
      platform: 'homeassistant',
      area_id: null,
      device_class: 'signal_strength',
      original_device_class: 'signal_strength',
      disabled_by: null,
      hidden_by: null,
      entity_category: 'diagnostic',
    },
    // Unmapped-domain entity — still skipped (no CamStack mapping).
    {
      entity_id: 'tts.home_assistant_cloud',
      unique_id: 'uid-tts-1',
      device_id: 'dev-abc',
      name: 'Cloud TTS',
      original_name: 'Cloud TTS',
      platform: 'homeassistant',
      area_id: null,
      device_class: null,
      original_device_class: null,
      disabled_by: null,
      hidden_by: null,
    },
  ]

  const states: Record<
    string,
    {
      entity_id: string
      state: string
      attributes: Record<string, unknown>
      last_changed: string
      last_updated: string
    }
  > = {
    'sensor.temperature': {
      entity_id: 'sensor.temperature',
      state: '21.5',
      attributes: {
        unit_of_measurement: '°C',
        device_class: 'temperature',
        friendly_name: 'Temperature',
      },
      last_changed: '2026-01-01T00:00:00+00:00',
      last_updated: '2026-01-01T00:00:00+00:00',
    },
    'cover.garage_door': {
      entity_id: 'cover.garage_door',
      state: 'closed',
      attributes: { supported_features: 4, friendly_name: 'Garage Door', device_class: 'garage' },
      last_changed: '2026-01-01T00:00:00+00:00',
      last_updated: '2026-01-01T00:00:00+00:00',
    },
  }

  it('produces one Container candidate per enabled HA device', () => {
    const candidates = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities,
      states,
    })

    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    expect(candidate.type).toBe(DeviceType.Container)
  })

  it('stableId follows ha:<brokerId>:dev:<device.id> pattern', () => {
    const candidate = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities,
      states,
    })[0]!
    expect(candidate.stableId).toBe(`ha:${brokerId}:dev:dev-abc`)
  })

  it('suggestedName uses device.name when name_by_user is null', () => {
    const candidate = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities,
      states,
    })[0]!
    expect(candidate.suggestedName).toBe('Living Room Hub')
  })

  it('prefers name_by_user over name', () => {
    const devWithUserName = [{ ...devices[0], name_by_user: 'My Hub' }]
    const candidate = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices: devWithUserName,
      entities,
      states,
    })[0]!
    expect(candidate.suggestedName).toBe('My Hub')
  })

  it('includes MAPPED enabled entities and skips disabled + unmapped domains', () => {
    const candidate = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities,
      states,
    })[0]!
    const entityList = candidate.prefilledConfig['entities'] as Array<{ entityId: string }>
    // cover.garage_door + sensor.temperature + sensor.rssi are mapped + enabled →
    // included. sensor.disabled is disabled → skipped. tts.home_assistant_cloud
    // is an unmapped domain → skipped.
    const ids = entityList.map((e) => e.entityId).toSorted()
    expect(ids).toEqual(['cover.garage_door', 'sensor.rssi', 'sensor.temperature'])
  })

  it('captures entity_category (diagnostic) as entityCategory; omits it for controls', () => {
    const candidate = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities,
      states,
    })[0]!
    const entityList = candidate.prefilledConfig['entities'] as Array<{
      entityId: string
      entityCategory?: string
    }>
    const diag = entityList.find((e) => e.entityId === 'sensor.rssi')
    expect(diag?.entityCategory).toBe('diagnostic')
    // A plain control entity carries no category.
    const control = entityList.find((e) => e.entityId === 'cover.garage_door')
    expect(control?.entityCategory).toBeUndefined()
  })

  it('first entity is the cover with correct deviceType and capabilities', () => {
    const candidate = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities,
      states,
    })[0]!
    const entityList = candidate.prefilledConfig['entities'] as Array<{
      entityId: string
      deviceType: string
      capabilities: string[]
    }>
    const cover = entityList.find((e) => e.entityId === 'cover.garage_door')
    expect(cover).toBeDefined()
    expect(cover?.deviceType).toBe(DeviceType.Cover)
    expect(cover?.capabilities).toContain('cover')
  })

  it('second entity is the temperature sensor with unitOfMeasurement', () => {
    const candidate = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities,
      states,
    })[0]!
    const entityList = candidate.prefilledConfig['entities'] as Array<{
      entityId: string
      deviceType: string
      unitOfMeasurement?: string
    }>
    const sensor = entityList.find((e) => e.entityId === 'sensor.temperature')
    expect(sensor).toBeDefined()
    expect(sensor?.deviceType).toBe(DeviceType.Sensor)
    expect(sensor?.unitOfMeasurement).toBe('°C')
  })

  it('prefilledConfig includes system=homeassistant, brokerId, haDeviceId, integrationId', () => {
    const candidate = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities,
      states,
    })[0]!
    expect(candidate.prefilledConfig['system']).toBe('homeassistant')
    expect(candidate.prefilledConfig['brokerId']).toBe(brokerId)
    expect(candidate.prefilledConfig['haDeviceId']).toBe('dev-abc')
    expect(candidate.prefilledConfig['integrationId']).toBe(integrationId)
  })

  it('omits integrationId from prefilledConfig when not provided', () => {
    const candidates = buildDiscoveryCandidates({
      brokerId,
      integrationId: undefined,
      devices,
      entities,
      states,
    })
    expect(candidates[0]!.prefilledConfig).not.toHaveProperty('integrationId')
  })

  it('sourceInfo has system=homeassistant and id=device.id', () => {
    const candidate = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities,
      states,
    })[0]!
    expect(candidate.sourceInfo?.system).toBe('homeassistant')
    expect(candidate.sourceInfo?.id).toBe('dev-abc')
  })

  it('skips disabled devices entirely', () => {
    const disabledDevices = [{ ...devices[0], disabled_by: 'user' }]
    const candidates = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices: disabledDevices,
      entities,
      states,
    })
    expect(candidates).toHaveLength(0)
  })

  it('device with no mappable entities still produces a candidate with empty entities list', () => {
    const unmappedEntities = [
      {
        entity_id: 'tts.living_room',
        unique_id: 'uid-tts',
        device_id: 'dev-abc',
        name: 'Living Room TTS',
        original_name: 'Living Room TTS',
        platform: 'homeassistant',
        area_id: null,
        device_class: null,
        original_device_class: null,
        disabled_by: null,
        hidden_by: null,
      },
    ]
    const candidates = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities: unmappedEntities,
      states: {},
    })
    expect(candidates).toHaveLength(1)
    const entityList = candidates[0]!.prefilledConfig['entities'] as unknown[]
    expect(entityList).toHaveLength(0)
  })

  it('camera entity maps to an Image device with the image cap', () => {
    const cameraEntities = [
      {
        entity_id: 'camera.living_room',
        unique_id: 'uid-cam',
        device_id: 'dev-abc',
        name: 'Living Room Camera',
        original_name: 'Living Room Camera',
        platform: 'homeassistant',
        area_id: null,
        device_class: null,
        original_device_class: null,
        disabled_by: null,
        hidden_by: null,
      },
    ]
    const candidate = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities: cameraEntities,
      states: {},
    })[0]!
    const entityList = candidate.prefilledConfig['entities'] as Array<{
      entityId: string
      deviceType: string
      capabilities: string[]
    }>
    expect(entityList).toHaveLength(1)
    expect(entityList[0]!.entityId).toBe('camera.living_room')
    expect(entityList[0]!.deviceType).toBe(DeviceType.Image)
    expect(entityList[0]!.capabilities).toContain('image')
  })

  it('select entity with attributes.options captures options in the entity record', () => {
    const selectEntities = [
      {
        entity_id: 'select.hvac_mode',
        unique_id: 'uid-select-1',
        device_id: 'dev-abc',
        name: 'HVAC Mode',
        original_name: 'HVAC Mode',
        platform: 'homeassistant',
        area_id: null,
        device_class: null,
        original_device_class: null,
        disabled_by: null,
        hidden_by: null,
      },
    ]
    const selectStates: typeof states = {
      'select.hvac_mode': {
        entity_id: 'select.hvac_mode',
        state: 'Eco',
        attributes: { options: ['Eco', 'Comfort'], friendly_name: 'HVAC Mode' },
        last_changed: '2026-01-01T00:00:00+00:00',
        last_updated: '2026-01-01T00:00:00+00:00',
      },
    }
    const candidates = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities: selectEntities,
      states: selectStates,
    })
    expect(candidates).toHaveLength(1)
    const entityList = candidates[0]!.prefilledConfig['entities'] as Array<{
      entityId: string
      options?: readonly string[]
    }>
    const selectEntry = entityList.find((e) => e.entityId === 'select.hvac_mode')
    expect(selectEntry).toBeDefined()
    expect(selectEntry?.options).toEqual(['Eco', 'Comfort'])
  })

  it('non-select entity without attributes.options does not include options field', () => {
    const candidate = buildDiscoveryCandidates({
      brokerId,
      integrationId,
      devices,
      entities,
      states,
    })[0]!
    const entityList = candidate.prefilledConfig['entities'] as Array<{
      entityId: string
      options?: unknown
    }>
    const coverEntry = entityList.find((e) => e.entityId === 'cover.garage_door')
    expect(coverEntry).toBeDefined()
    expect(coverEntry?.options).toBeUndefined()
  })
})
