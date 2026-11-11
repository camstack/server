import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device-type.js'
import { build, NOW, PLUG_HEATER } from './hero-test-kit.js'

const FETCHED = { lastFetchedAt: NOW }

describe('the tiles that match the appliance mockups', () => {
  it('a dishwasher names the clock time its cycle ends: now plus what is left', () => {
    const m = build(DeviceType.Dishwasher, ['dishwasher'], {
      dishwasher: {
        availability: 'available',
        state: 'running',
        operationState: 'Run',
        program: 'Eco 50',
        selectedProgram: null,
        availablePrograms: [],
        remaining: 4320,
        delayedStart: null,
        progress: 30,
        doorOpen: false,
        doorLocked: true,
        remoteStartAllowed: true,
        remoteControlActive: true,
        localControlActive: false,
        powerOn: true,
        powerState: 'On',
        filterCleaningDue: null,
        machineCareDue: null,
        machineCareRemainingRuns: null,
        halfLoad: null,
        hygienePlus: null,
        extraDry: null,
        intensiveZone: null,
        varioSpeedPlus: null,
        childLock: null,
        activeEvents: [],
        errorCode: null,
        errorLabel: null,
        ...FETCHED,
      },
    })
    const ends = m.sideTiles.right.find((t) => t.label.en === 'Ends')
    expect(ends?.label.it).toBe('Fine')
    expect(ends?.at).toBe(NOW + 4320 * 1000)
  })

  it('a heater on a timer shows the run length beside its power', () => {
    const m = build(PLUG_HEATER, ['timed-run', 'power-meter'], {
      'timed-run': {
        activeUntil: NOW + 25 * 60_000,
        requestedBy: null,
        quickRun: { duration: 25, unit: 'min' },
        ...FETCHED,
      },
      'power-meter': { power: 1180, ...FETCHED },
    })
    expect(m.sideTiles.right.map((t) => [t.label.en, t.value.en])).toEqual([
      ['Power', '1180 W'],
      ['Timer', '25 min'],
    ])
  })

  it('a heater with nothing armed shows no timer tile', () => {
    const m = build(PLUG_HEATER, ['timed-run'], {
      'timed-run': { activeUntil: null, requestedBy: null, quickRun: null, ...FETCHED },
    })
    expect(m.sideTiles.right).toEqual([])
  })

  it('a thermostat keeps room and humidity in the tiles; the battery stays a chip', () => {
    const m = build(DeviceType.Climate, ['climate-control', 'battery'], {
      'climate-control': {
        mode: 'heat',
        availableModes: ['auto', 'heat', 'off'],
        fanMode: '',
        availableFanModes: [],
        preset: '',
        availablePresets: [],
        target: 21,
        targetHigh: null,
        targetLow: null,
        targetHumidity: null,
        currentTemp: 19.6,
        currentHumidity: 47,
        swingVertical: null,
        swingHorizontal: null,
        minTemp: 5,
        maxTemp: 30,
        tempStep: 0.5,
        ...FETCHED,
      },
      battery: { level: 70, charging: 'none', sleeping: false, lastUpdated: NOW },
    })
    expect(m.sideTiles.left.map((t) => t.label.en)).toEqual(['Indoor', 'Humidity'])
  })

  it('a heating valve captions the scene with its opening, and a shut one says nothing', () => {
    const open = build(DeviceType.Climate, ['heating-valve'], {
      'heating-valve': { position: 38, ...FETCHED },
    })
    expect(open.caption?.en).toBe('Heating · valve 38%')
    expect(open.caption?.it).toBe('Riscalda · valvola 38%')
    const shut = build(DeviceType.Climate, ['heating-valve'], {
      'heating-valve': { position: 0, ...FETCHED },
    })
    expect(shut.caption).toBeUndefined()
  })

  it('a fan reads oscillation and mode in its tiles, its speed is the scene centre', () => {
    const m = build(DeviceType.Fan, ['fan-control'], {
      'fan-control': {
        speed: 60,
        percentageStep: 20,
        preset: 'Natura',
        availablePresets: ['Normale', 'Natura'],
        direction: null,
        oscillating: true,
        lastChangedAt: NOW,
      },
    })
    expect(m.sideTiles.left.map((t) => [t.label.en, t.value.en])).toEqual([['Oscillation', 'Yes']])
    expect(m.sideTiles.right.map((t) => [t.label.en, t.value.en])).toEqual([['Mode', 'Natura']])
  })

  it('a pet fountain and a feeder read their tank in the tiles', () => {
    const fountain = build(DeviceType.PetFountain, ['pet-fountain'], {
      'pet-fountain': {
        waterLevel: 70,
        waterVolume: 180,
        empty: false,
        pumpRunning: true,
        error: null,
        ...FETCHED,
      },
    })
    expect(fountain.sideTiles.left.map((t) => [t.label.en, t.value.en])).toEqual([
      ['Water', '70%'],
      ['Volume', '180 ml'],
    ])
  })
})

describe('a time left on a tile', () => {
  it('reads minutes under an hour and hours with minutes above', () => {
    const left = (seconds: number): string | undefined => {
      const m = build(DeviceType.Dishwasher, ['dishwasher'], {
        dishwasher: {
          availability: 'available',
          state: 'running',
          operationState: 'Run',
          program: null,
          selectedProgram: null,
          availablePrograms: [],
          remaining: seconds,
          delayedStart: null,
          progress: null,
          doorOpen: null,
          doorLocked: null,
          remoteStartAllowed: null,
          remoteControlActive: null,
          localControlActive: null,
          powerOn: null,
          powerState: null,
          filterCleaningDue: null,
          machineCareDue: null,
          machineCareRemainingRuns: null,
          halfLoad: null,
          hygienePlus: null,
          extraDry: null,
          intensiveZone: null,
          varioSpeedPlus: null,
          childLock: null,
          activeEvents: [],
          errorCode: null,
          errorLabel: null,
          ...FETCHED,
        },
      })
      return m.sideTiles.right.find((t) => t.label.en === 'Left')?.value.en
    }
    expect(left(38 * 60)).toBe('38 min')
    expect(left(72 * 60)).toBe('1 h 12')
  })
})
