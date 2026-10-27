import { describe, expect, it } from 'vitest'
import {
  applyCapCommand,
  CAP_COMMAND_ROUTES,
  type CapCommandDevice,
  type CapExportCommand,
  type CommandTarget,
  hasButtonCommandRoute,
  hasCommandRoute,
  hasExtraCommandRoute,
  isCapCommand,
  resolveCommand,
} from '../command-routes.js'
import { capCommandEntities, capEntities, CAP_ENTITY_MAP } from '../entity-catalog.js'
import { derivedEntityId, derivedExtraEntityId } from '../topics.js'
import type { ClimateControlStatus } from '@camstack/types'

const CAMERA: CommandTarget = {
  deviceId: 101,
  type: 'camera',
  boundCaps: ['ptz'],
}
const SWITCH: CommandTarget = {
  deviceId: 700,
  type: 'switch',
  boundCaps: ['switch'],
}

function commandFor(target: CommandTarget, entity: string, value: string): CapExportCommand {
  const resolution = resolveCommand(target, entity, value)
  if (!resolution.ok) throw new Error(`expected a command, got ${resolution.reason}`)
  if (!isCapCommand(resolution.command)) throw new Error('expected a capability command')
  return resolution.command
}

interface RecordedCall {
  readonly method: string
  readonly input: unknown
}

/** Records one call. Typed `unknown` so it fits every method's input. */
function rec(calls: RecordedCall[], method: string) {
  return async (input: unknown): Promise<void> => {
    calls.push({ method, input })
  }
}

/**
 * A `DeviceProxy` slice that records instead of calling.
 *
 * Typed as the real `Pick<DeviceProxy, …>`, so a cap whose method name
 * or input changes in codegen breaks this file rather than the hub.
 */
function recordingDevice(calls: RecordedCall[]): CapCommandDevice {
  return {
    cover: {
      open: rec(calls, 'cover.open'),
      close: rec(calls, 'cover.close'),
      stop: rec(calls, 'cover.stop'),
      setPosition: rec(calls, 'cover.setPosition'),
      setTiltPosition: rec(calls, 'cover.setTiltPosition'),
      getStatus: async () => null,
    },
    climateControl: {
      setMode: rec(calls, 'climateControl.setMode'),
      setFanMode: rec(calls, 'climateControl.setFanMode'),
      setPreset: rec(calls, 'climateControl.setPreset'),
      setTarget: rec(calls, 'climateControl.setTarget'),
      setTargetRange: rec(calls, 'climateControl.setTargetRange'),
      setTargetHumidity: rec(calls, 'climateControl.setTargetHumidity'),
      setSwingVertical: rec(calls, 'climateControl.setSwingVertical'),
      setSwingHorizontal: rec(calls, 'climateControl.setSwingHorizontal'),
      getStatus: async () => null,
    },
    fanControl: {
      setPercentage: rec(calls, 'fanControl.setPercentage'),
      setPreset: rec(calls, 'fanControl.setPreset'),
      setDirection: rec(calls, 'fanControl.setDirection'),
      setOscillating: rec(calls, 'fanControl.setOscillating'),
      getStatus: async () => null,
    },
    humidifier: {
      setOn: rec(calls, 'humidifier.setOn'),
      setTargetHumidity: rec(calls, 'humidifier.setTargetHumidity'),
      setMode: rec(calls, 'humidifier.setMode'),
      getStatus: async () => null,
    },
    waterHeater: {
      setTargetTemp: rec(calls, 'waterHeater.setTargetTemp'),
      setOperationMode: rec(calls, 'waterHeater.setOperationMode'),
      setAway: rec(calls, 'waterHeater.setAway'),
      getStatus: async () => null,
    },
    valve: {
      open: rec(calls, 'valve.open'),
      close: rec(calls, 'valve.close'),
      stop: rec(calls, 'valve.stop'),
      setPosition: rec(calls, 'valve.setPosition'),
      getStatus: async () => null,
    },
    vacuumControl: {
      start: rec(calls, 'vacuumControl.start'),
      pause: rec(calls, 'vacuumControl.pause'),
      stop: rec(calls, 'vacuumControl.stop'),
      returnToBase: rec(calls, 'vacuumControl.returnToBase'),
      locate: rec(calls, 'vacuumControl.locate'),
      setFanSpeed: rec(calls, 'vacuumControl.setFanSpeed'),
      getStatus: async () => null,
    },
    lawnMowerControl: {
      startMowing: rec(calls, 'lawnMowerControl.startMowing'),
      pause: rec(calls, 'lawnMowerControl.pause'),
      dock: rec(calls, 'lawnMowerControl.dock'),
      getStatus: async () => null,
    },
    mediaPlayer: {
      play: rec(calls, 'mediaPlayer.play'),
      pause: rec(calls, 'mediaPlayer.pause'),
      stop: rec(calls, 'mediaPlayer.stop'),
      next: rec(calls, 'mediaPlayer.next'),
      previous: rec(calls, 'mediaPlayer.previous'),
      seek: rec(calls, 'mediaPlayer.seek'),
      setVolume: rec(calls, 'mediaPlayer.setVolume'),
      setMute: rec(calls, 'mediaPlayer.setMute'),
      setShuffle: rec(calls, 'mediaPlayer.setShuffle'),
      setRepeat: rec(calls, 'mediaPlayer.setRepeat'),
      selectSource: rec(calls, 'mediaPlayer.selectSource'),
      playMedia: rec(calls, 'mediaPlayer.playMedia'),
      getStatus: async () => null,
    },
    color: {
      setColor: rec(calls, 'color.setColor'),
      getStatus: async () => null,
    },
    scriptRunner: {
      run: rec(calls, 'scriptRunner.run'),
      stop: rec(calls, 'scriptRunner.stop'),
      getStatus: async () => null,
    },
    dishwasher: {
      start: rec(calls, 'dishwasher.start'),
      pause: rec(calls, 'dishwasher.pause'),
      resume: rec(calls, 'dishwasher.resume'),
      stop: rec(calls, 'dishwasher.stop'),
      setProgram: rec(calls, 'dishwasher.setProgram'),
      setPower: rec(calls, 'dishwasher.setPower'),
      setHalfLoad: rec(calls, 'dishwasher.setHalfLoad'),
      setHygienePlus: rec(calls, 'dishwasher.setHygienePlus'),
      setExtraDry: rec(calls, 'dishwasher.setExtraDry'),
      setIntensiveZone: rec(calls, 'dishwasher.setIntensiveZone'),
      setVarioSpeedPlus: rec(calls, 'dishwasher.setVarioSpeedPlus'),
      setChildLock: rec(calls, 'dishwasher.setChildLock'),
      setOption: rec(calls, 'dishwasher.setOption'),
      getOptions: async () => ({
        availability: 'available',
        supportsStart: true,
        supportsPause: true,
        supportsResume: true,
        supportsStop: true,
        supportsPower: true,
        programs: [],
        options: [],
      }),
      getStatus: async () => null,
    },
    automationControl: {
      enable: rec(calls, 'automationControl.enable'),
      disable: rec(calls, 'automationControl.disable'),
      trigger: rec(calls, 'automationControl.trigger'),
      getStatus: async () => null,
    },
    switch: {
      setState: async (input) => {
        calls.push({ method: 'switch.setState', input })
      },
      getStatus: async () => null,
    },
    lockControl: {
      lock: async (input) => {
        calls.push({ method: 'lockControl.lock', input })
      },
      unlock: async (input) => {
        calls.push({ method: 'lockControl.unlock', input })
      },
      open: async (input) => {
        calls.push({ method: 'lockControl.open', input })
      },
      getStatus: async () => null,
    },
    brightness: {
      setBrightness: async (input) => {
        calls.push({ method: 'brightness.setBrightness', input })
      },
      getStatus: async () => null,
    },
    alarmPanel: {
      arm: async (input) => {
        calls.push({ method: 'alarmPanel.arm', input })
      },
      disarm: async (input) => {
        calls.push({ method: 'alarmPanel.disarm', input })
      },
      trigger: async (input) => {
        calls.push({ method: 'alarmPanel.trigger', input })
      },
      getStatus: async () => null,
    },
    button: {
      press: async (input) => {
        calls.push({ method: 'button.press', input })
      },
    },
    control: {
      setValue: async (input) => {
        calls.push({ method: 'control.setValue', input })
      },
      getStatus: async () => ({
        kind: 'select' as const,
        value: 'it452 - 1.2.3.4',
        options: ['it452 - 1.2.3.4', 'it536 - 5.6.7.8'],
        lastChangedAt: 1,
      }),
    },
  }
}

describe('resolveCommand — the camera surfaces', () => {
  it('routes a camera function as camera-function, resolved against the authority, not a group', () => {
    expect(resolveCommand(CAMERA, 'recording', 'true')).toEqual({
      ok: true,
      command: {
        kind: 'camera-function',
        deviceId: 101,
        switchId: 'recording',
        enabled: true,
      },
    })
    expect(resolveCommand(CAMERA, 'privacy_mask', 'false')).toEqual({
      ok: true,
      command: {
        kind: 'camera-function',
        deviceId: 101,
        switchId: 'privacy-mask',
        enabled: false,
      },
    })
  })

  it('routes reboot', () => {
    expect(resolveCommand(CAMERA, 'reboot', 'PRESS')).toEqual({
      ok: true,
      command: { kind: 'reboot', deviceId: 101 },
    })
  })

  it('routes each PTZ direction and the zoom pair', () => {
    expect(resolveCommand(CAMERA, 'ptz_up', 'PRESS')).toEqual({
      ok: true,
      command: { kind: 'ptz-move', deviceId: 101, direction: 'up' },
    })
    expect(resolveCommand(CAMERA, 'ptz_zoom_in', 'PRESS')).toEqual({
      ok: true,
      command: { kind: 'ptz-move', deviceId: 101, direction: 'zoom_in' },
    })
  })

  it('routes a PTZ preset by name', () => {
    expect(resolveCommand(CAMERA, 'ptz_preset', 'Gate')).toEqual({
      ok: true,
      command: { kind: 'ptz-preset', deviceId: 101, preset: 'Gate' },
    })
  })

  it('refuses a PTZ command on a camera that does not declare the cap', () => {
    expect(resolveCommand({ ...CAMERA, boundCaps: [] }, 'ptz_up', 'PRESS')).toEqual({
      ok: false,
      reason: 'cap-not-bound',
      capName: 'ptz',
    })
  })

  it('refuses an unroutable entity rather than guessing', () => {
    expect(resolveCommand(CAMERA, 'nonsense', 'true')).toEqual({
      ok: false,
      reason: 'unknown-entity',
    })
  })

  it('refuses a malformed boolean rather than reading it as off', () => {
    expect(resolveCommand(CAMERA, 'recording', 'maybe')).toEqual({
      ok: false,
      reason: 'bad-value',
    })
  })
})

describe('resolveCommand — the derived half', () => {
  it('routes a switch to the switch cap', () => {
    expect(resolveCommand(SWITCH, 'switch', 'true')).toEqual({
      ok: true,
      command: {
        kind: 'cap-switch',
        deviceId: 700,
        capName: 'switch',
        on: true,
      },
    })
  })

  it('routes a lock to its own command, not to a switch', () => {
    const target: CommandTarget = {
      deviceId: 800,
      type: 'lock',
      boundCaps: ['lock-control'],
    }
    expect(resolveCommand(target, 'lock_control', 'true')).toEqual({
      ok: true,
      command: { kind: 'cap-lock', deviceId: 800, locked: true },
    })
    expect(resolveCommand(target, 'lock_control', 'unlock')).toEqual({
      ok: true,
      command: { kind: 'cap-lock', deviceId: 800, locked: false },
    })
  })

  it('routes brightness as a NUMBER — the payload that never parsed as a boolean', () => {
    const target: CommandTarget = {
      deviceId: 810,
      type: 'light',
      boundCaps: ['brightness'],
    }
    expect(resolveCommand(target, 'brightness', '42')).toEqual({
      ok: true,
      command: { kind: 'cap-brightness', deviceId: 810, percentage: 42 },
    })
  })

  it('refuses a brightness outside the range the cap declares', () => {
    const target: CommandTarget = {
      deviceId: 810,
      type: 'light',
      boundCaps: ['brightness'],
    }
    expect(resolveCommand(target, 'brightness', '120')).toEqual({
      ok: false,
      reason: 'bad-value',
      capName: 'brightness',
    })
    expect(resolveCommand(target, 'brightness', 'on')).toEqual({
      ok: false,
      reason: 'bad-value',
      capName: 'brightness',
    })
  })

  it('speaks all three alarm vocabularies — HA command, cap mode and HA state', () => {
    const target: CommandTarget = {
      deviceId: 820,
      type: 'alarm-panel',
      boundCaps: ['alarm-panel'],
    }
    expect(resolveCommand(target, 'alarm_panel', 'ARM_AWAY')).toEqual({
      ok: true,
      command: {
        kind: 'cap-alarm',
        deviceId: 820,
        action: { kind: 'arm', mode: 'away' },
      },
    })
    expect(resolveCommand(target, 'alarm_panel', 'night')).toEqual({
      ok: true,
      command: {
        kind: 'cap-alarm',
        deviceId: 820,
        action: { kind: 'arm', mode: 'night' },
      },
    })
    expect(resolveCommand(target, 'alarm_panel', 'armed_home')).toEqual({
      ok: true,
      command: {
        kind: 'cap-alarm',
        deviceId: 820,
        action: { kind: 'arm', mode: 'home' },
      },
    })
    expect(resolveCommand(target, 'alarm_panel', 'DISARM')).toEqual({
      ok: true,
      command: { kind: 'cap-alarm', deviceId: 820, action: { kind: 'disarm' } },
    })
    expect(resolveCommand(target, 'alarm_panel', 'TRIGGER')).toEqual({
      ok: true,
      command: {
        kind: 'cap-alarm',
        deviceId: 820,
        action: { kind: 'trigger' },
      },
    })
  })

  it('refuses an arm mode the cap does not declare', () => {
    const target: CommandTarget = {
      deviceId: 820,
      type: 'alarm-panel',
      boundCaps: ['alarm-panel'],
    }
    expect(resolveCommand(target, 'alarm_panel', 'ARM_PANIC')).toEqual({
      ok: false,
      reason: 'bad-value',
      capName: 'alarm-panel',
    })
  })

  it('routes a button press', () => {
    const target: CommandTarget = {
      deviceId: 830,
      type: 'button',
      boundCaps: ['button'],
    }
    expect(resolveCommand(target, 'button', 'PRESS')).toEqual({
      ok: true,
      command: { kind: 'cap-button', deviceId: 830, capName: 'button' },
    })
  })

  it('routes a control select write through control.setValue with the slice kind', async () => {
    const target: CommandTarget = {
      deviceId: 4652,
      type: 'control',
      boundCaps: ['control'],
    }
    expect(resolveCommand(target, 'control', 'it536 - 5.6.7.8')).toEqual({
      ok: true,
      command: { kind: 'cap-control', deviceId: 4652, value: 'it536 - 5.6.7.8' },
    })
    const calls: RecordedCall[] = []
    const outcome = await applyCapCommand(
      recordingDevice(calls),
      commandFor(target, 'control', 'it536 - 5.6.7.8'),
    )
    expect(outcome).toEqual({ ok: true })
    expect(calls).toEqual([
      {
        method: 'control.setValue',
        input: { control: { kind: 'select', value: 'it536 - 5.6.7.8' } },
      },
    ])
  })

  /**
   * The row that made this case real is gone: `siren` was declared
   * writable in the catalog and **no `siren.cap.ts` exists** — a Siren
   * device carries `switch`. Before the route table it resolved to
   * `cap-switch` and the dispatcher called `device.switch.setState`, one
   * of the four controls advertising a function they could not perform.
   * T3 deleted the row; the refusal branch stays, because the next
   * writable descriptor added without a route must hit it rather than
   * reach a neighbouring capability's method.
   */
  it('has no writable descriptor left that the route table cannot write', () => {
    expect(CAP_ENTITY_MAP['siren']).toBeUndefined()
    const lying = Object.entries(CAP_ENTITY_MAP)
      .filter(([cap, mapping]) => mapping.writable === true && !hasCommandRoute(cap))
      .map(([cap]) => cap)
    expect(lying).toEqual([])
  })

  it('refuses a read-only capability rather than writing it', () => {
    const target: CommandTarget = {
      deviceId: 850,
      type: 'sensor',
      boundCaps: ['contact'],
    }
    expect(resolveCommand(target, 'contact', 'true')).toEqual({
      ok: false,
      reason: 'not-writable',
      capName: 'contact',
    })
  })

  it('refuses a capability the device does not declare', () => {
    const target: CommandTarget = {
      deviceId: 860,
      type: 'lock',
      boundCaps: [],
    }
    expect(resolveCommand(target, 'lock_control', 'true')).toEqual({
      ok: false,
      reason: 'cap-not-bound',
      capName: 'lock-control',
    })
  })

  /**
   * Tier A, end to end: the topic Home Assistant posts to → the method the
   * capability declares → the input it declares. One row per writable entity
   * and per command button, and the entity ids are built with the CATALOG's
   * own expressions, so a row cannot address an entity the export never
   * announced.
   */
  const TIER_A: readonly {
    readonly cap: string
    /** `extras` suffix, `commands` suffix (with `!`), or absent for primary. */
    readonly suffix?: string
    readonly value: string
    readonly method: string
    readonly input: unknown
  }[] = [
    {
      cap: 'cover',
      suffix: 'position',
      value: '0',
      method: 'cover.setPosition',
      input: { position: 0 },
    },
    {
      cap: 'cover',
      suffix: 'tilt',
      value: '35',
      method: 'cover.setTiltPosition',
      input: { tiltPosition: 35 },
    },
    {
      cap: 'cover',
      suffix: '!open',
      value: 'PRESS',
      method: 'cover.open',
      input: {},
    },
    {
      cap: 'cover',
      suffix: '!close',
      value: 'PRESS',
      method: 'cover.close',
      input: {},
    },
    {
      cap: 'cover',
      suffix: '!stop',
      value: 'PRESS',
      method: 'cover.stop',
      input: {},
    },
    {
      cap: 'climate-control',
      value: 'heat_cool',
      method: 'climateControl.setMode',
      input: { mode: 'heat_cool' },
    },
    {
      cap: 'climate-control',
      suffix: 'target',
      value: '20.5',
      method: 'climateControl.setTarget',
      input: { target: 20.5 },
    },
    {
      cap: 'climate-control',
      suffix: 'target-humidity',
      value: '45',
      method: 'climateControl.setTargetHumidity',
      input: { targetHumidity: 45 },
    },
    {
      cap: 'climate-control',
      suffix: 'swing-vertical',
      value: 'true',
      method: 'climateControl.setSwingVertical',
      input: { on: true },
    },
    {
      cap: 'climate-control',
      suffix: 'swing-horizontal',
      value: 'false',
      method: 'climateControl.setSwingHorizontal',
      input: { on: false },
    },
    {
      cap: 'fan-control',
      value: '75',
      method: 'fanControl.setPercentage',
      input: { speed: 75 },
    },
    {
      cap: 'fan-control',
      suffix: 'oscillating',
      value: 'true',
      method: 'fanControl.setOscillating',
      input: { oscillating: true },
    },
    {
      cap: 'fan-control',
      suffix: 'direction',
      value: 'reverse',
      method: 'fanControl.setDirection',
      input: { direction: 'reverse' },
    },
    {
      cap: 'humidifier',
      value: 'true',
      method: 'humidifier.setOn',
      input: { on: true },
    },
    {
      cap: 'humidifier',
      suffix: 'target-humidity',
      value: '55',
      method: 'humidifier.setTargetHumidity',
      input: { humidity: 55 },
    },
    {
      cap: 'water-heater',
      suffix: 'target',
      value: '-5',
      method: 'waterHeater.setTargetTemp',
      input: { temp: -5 },
    },
    {
      cap: 'water-heater',
      suffix: 'away',
      value: 'true',
      method: 'waterHeater.setAway',
      input: { on: true },
    },
    {
      cap: 'valve',
      suffix: 'position',
      value: '100',
      method: 'valve.setPosition',
      input: { position: 100 },
    },
    {
      cap: 'valve',
      suffix: '!open',
      value: 'PRESS',
      method: 'valve.open',
      input: {},
    },
    {
      cap: 'valve',
      suffix: '!close',
      value: 'PRESS',
      method: 'valve.close',
      input: {},
    },
    {
      cap: 'valve',
      suffix: '!stop',
      value: 'PRESS',
      method: 'valve.stop',
      input: {},
    },
    {
      cap: 'vacuum-control',
      suffix: '!start',
      value: 'PRESS',
      method: 'vacuumControl.start',
      input: {},
    },
    {
      cap: 'vacuum-control',
      suffix: '!pause',
      value: 'PRESS',
      method: 'vacuumControl.pause',
      input: {},
    },
    {
      cap: 'vacuum-control',
      suffix: '!stop',
      value: 'PRESS',
      method: 'vacuumControl.stop',
      input: {},
    },
    {
      cap: 'vacuum-control',
      suffix: '!return-to-base',
      value: 'PRESS',
      method: 'vacuumControl.returnToBase',
      input: {},
    },
    {
      cap: 'vacuum-control',
      suffix: '!locate',
      value: 'PRESS',
      method: 'vacuumControl.locate',
      input: {},
    },
    {
      cap: 'lawn-mower-control',
      suffix: '!start',
      value: 'PRESS',
      method: 'lawnMowerControl.startMowing',
      input: {},
    },
    {
      cap: 'lawn-mower-control',
      suffix: '!pause',
      value: 'PRESS',
      method: 'lawnMowerControl.pause',
      input: {},
    },
    {
      cap: 'lawn-mower-control',
      suffix: '!dock',
      value: 'PRESS',
      method: 'lawnMowerControl.dock',
      input: {},
    },
    {
      cap: 'media-player',
      suffix: 'volume',
      value: '30',
      method: 'mediaPlayer.setVolume',
      input: { volumeLevel: 30 },
    },
    {
      cap: 'media-player',
      suffix: 'muted',
      value: 'true',
      method: 'mediaPlayer.setMute',
      input: { muted: true },
    },
    {
      cap: 'media-player',
      suffix: 'shuffle',
      value: 'false',
      method: 'mediaPlayer.setShuffle',
      input: { shuffle: false },
    },
    {
      cap: 'media-player',
      suffix: 'repeat',
      value: 'all',
      method: 'mediaPlayer.setRepeat',
      input: { repeat: 'all' },
    },
    {
      cap: 'media-player',
      suffix: '!play',
      value: 'PRESS',
      method: 'mediaPlayer.play',
      input: {},
    },
    {
      cap: 'media-player',
      suffix: '!pause',
      value: 'PRESS',
      method: 'mediaPlayer.pause',
      input: {},
    },
    {
      cap: 'media-player',
      suffix: '!stop',
      value: 'PRESS',
      method: 'mediaPlayer.stop',
      input: {},
    },
    {
      cap: 'media-player',
      suffix: '!next',
      value: 'PRESS',
      method: 'mediaPlayer.next',
      input: {},
    },
    {
      cap: 'media-player',
      suffix: '!previous',
      value: 'PRESS',
      method: 'mediaPlayer.previous',
      input: {},
    },
    {
      cap: 'color',
      suffix: 'mireds',
      value: '370',
      method: 'color.setColor',
      input: { color: { mode: 'mired', colorTemperature: 370 } },
    },
    {
      cap: 'script-runner',
      suffix: '!run',
      value: 'PRESS',
      method: 'scriptRunner.run',
      input: {},
    },
    {
      cap: 'script-runner',
      suffix: '!stop',
      value: 'PRESS',
      method: 'scriptRunner.stop',
      input: {},
    },
    {
      cap: 'automation-control',
      value: 'true',
      method: 'automationControl.enable',
      input: {},
    },
    {
      cap: 'automation-control',
      value: 'false',
      method: 'automationControl.disable',
      input: {},
    },
    {
      cap: 'automation-control',
      suffix: '!trigger',
      value: 'PRESS',
      method: 'automationControl.trigger',
      input: {},
    },

    /**
     * The free-form vocabularies. Each is written by a real cap method and
     * has no closed list, so its DEGRADED entity is a read-only `sensor`
     * and its NATIVE entity carries the control — `writable` is a fact
     * about the capability, not about the platform. They shipped
     * unroutable until 2026-08-14, which left every native climate without
     * a fan mode, every native vacuum without a fan speed and every native
     * water heater unable to change its own state.
     */
    {
      cap: 'climate-control',
      suffix: 'fan-mode',
      value: 'auto',
      method: 'climateControl.setFanMode',
      input: { fanMode: 'auto' },
    },
    {
      cap: 'climate-control',
      suffix: 'preset',
      value: 'comfort',
      method: 'climateControl.setPreset',
      input: { preset: 'comfort' },
    },
    {
      cap: 'fan-control',
      suffix: 'preset',
      value: 'sleep',
      method: 'fanControl.setPreset',
      input: { preset: 'sleep' },
    },
    {
      cap: 'humidifier',
      suffix: 'mode',
      value: 'auto',
      method: 'humidifier.setMode',
      input: { mode: 'auto' },
    },
    {
      cap: 'water-heater',
      suffix: 'mode',
      value: 'eco',
      method: 'waterHeater.setOperationMode',
      input: { mode: 'eco' },
    },
    {
      cap: 'vacuum-control',
      suffix: 'fan-speed',
      value: 'turbo',
      method: 'vacuumControl.setFanSpeed',
      input: { speed: 'turbo' },
    },
    {
      cap: 'media-player',
      suffix: 'source',
      value: 'HDMI 1',
      method: 'mediaPlayer.selectSource',
      input: { source: 'HDMI 1' },
    },
    {
      cap: 'dishwasher',
      suffix: 'power',
      value: 'true',
      method: 'dishwasher.setPower',
      input: { on: true },
    },
    {
      cap: 'dishwasher',
      suffix: 'child-lock',
      value: 'true',
      method: 'dishwasher.setChildLock',
      input: { on: true },
    },
    {
      cap: 'dishwasher',
      suffix: 'half-load',
      value: 'true',
      method: 'dishwasher.setHalfLoad',
      input: { on: true },
    },
    {
      cap: 'dishwasher',
      suffix: 'hygiene-plus',
      value: 'true',
      method: 'dishwasher.setHygienePlus',
      input: { on: true },
    },
    {
      cap: 'dishwasher',
      suffix: 'extra-dry',
      value: 'true',
      method: 'dishwasher.setExtraDry',
      input: { on: true },
    },
    {
      cap: 'dishwasher',
      suffix: 'intensive-zone',
      value: 'true',
      method: 'dishwasher.setIntensiveZone',
      input: { on: true },
    },
    {
      cap: 'dishwasher',
      suffix: 'vario-speed-plus',
      value: 'true',
      method: 'dishwasher.setVarioSpeedPlus',
      input: { on: true },
    },
    {
      cap: 'dishwasher',
      suffix: '!start',
      value: 'PRESS',
      method: 'dishwasher.start',
      input: {},
    },
    {
      cap: 'dishwasher',
      suffix: '!pause',
      value: 'PRESS',
      method: 'dishwasher.pause',
      input: {},
    },
    {
      cap: 'dishwasher',
      suffix: '!resume',
      value: 'PRESS',
      method: 'dishwasher.resume',
      input: {},
    },
    {
      cap: 'dishwasher',
      suffix: '!stop',
      value: 'PRESS',
      method: 'dishwasher.stop',
      input: {},
    },
  ]

  function entityOf(row: { cap: string; suffix?: string }): string {
    if (row.suffix === undefined) return derivedEntityId(row.cap)
    return derivedExtraEntityId(row.cap, row.suffix.replace(/^!/, ''))
  }

  it('routes every Tier A entity to the method its capability declares', async () => {
    for (const row of TIER_A) {
      const target: CommandTarget = {
        deviceId: 900,
        type: 'generic',
        boundCaps: [row.cap],
      }
      const label = `${row.cap} → ${entityOf(row)}`
      const calls: RecordedCall[] = []
      const outcome = await applyCapCommand(
        recordingDevice(calls),
        commandFor(target, entityOf(row), row.value),
      )
      expect(outcome, label).toEqual({ ok: true })
      expect(calls, label).toEqual([{ method: row.method, input: row.input }])
    }
  })

  /**
   * The one thing a widened route table must never do. Before T1 every
   * non-button writable cap collapsed to `switch.setState`; the failure this
   * asserts against is the same one arrived at from the other direction —
   * forty-four routes, none of which may reach a neighbouring cap.
   */
  it('never lets a Tier A command reach another capability', async () => {
    for (const row of TIER_A) {
      const target: CommandTarget = {
        deviceId: 900,
        type: 'generic',
        boundCaps: [row.cap],
      }
      const calls: RecordedCall[] = []
      await applyCapCommand(recordingDevice(calls), commandFor(target, entityOf(row), row.value))
      const slice = row.method.split('.')[0]
      expect(
        calls.map((c) => c.method.split('.')[0]),
        row.method,
      ).toEqual([slice])
    }
  })

  /**
   * A device that DECLARES the capability and serves no provider. The empty
   * proxy is the real shape of that: `fetchDevice` returns a proxy whose
   * slice is `undefined` when nothing is bound. It must be refused by name,
   * never silently dropped.
   */
  it('refuses every Tier A command when nothing serves the capability', async () => {
    for (const row of TIER_A) {
      const target: CommandTarget = {
        deviceId: 900,
        type: 'generic',
        boundCaps: [row.cap],
      }
      const outcome = await applyCapCommand({}, commandFor(target, entityOf(row), row.value))
      expect(outcome, row.method).toEqual({
        ok: false,
        reason: 'no-provider',
        capName: row.cap,
      })
    }
  })

  /**
   * The arm-refusal path, generalised. Every Tier A method can be turned
   * down by the device — a cover already moving, a mode the unit does not
   * have in `availableModes`, a vacuum with a full bin — and the operator's
   * answer is the device's own message, surfaced as a 422 by the caller.
   * Acking a refused call would leave Home Assistant showing a state the
   * device never reached.
   */
  it('surfaces a REFUSED Tier A command with the device message, never as success', async () => {
    const target: CommandTarget = {
      deviceId: 900,
      type: 'generic',
      boundCaps: ['cover'],
    }
    const device: CapCommandDevice = {
      cover: {
        open: async () => {
          throw new Error('Cover is already opening')
        },
        close: async () => {},
        stop: async () => {},
        setPosition: async () => {},
        setTiltPosition: async () => {},
        getStatus: async () => null,
      },
    }
    const outcome = await applyCapCommand(device, commandFor(target, 'cover_open', 'PRESS'))
    expect(outcome).toEqual({
      ok: false,
      reason: 'refused',
      capName: 'cover',
      error: 'Cover is already opening',
    })
  })

  /**
   * Routes whose test cannot be a row of {@link TIER_A}, with the reason.
   * Named rather than skipped: an untested route is what this assertion
   * exists to find, so an exemption has to say why it is one.
   */
  const TESTED_SEPARATELY: readonly string[] = [
    // `setTargetRange` READS before it writes, so its case needs a device
    // that reports the other edge — see the dual-setpoint tests below.
    'climate-control:target-low',
    'climate-control:target-high',
  ]

  it('covers every route the table declares — no row ships untested', () => {
    const tested = new Set([
      ...TIER_A.map((row) => `${row.cap}:${row.suffix ?? ''}`),
      ...TESTED_SEPARATELY,
    ])
    const untested: string[] = []
    for (const [cap, route] of Object.entries(CAP_COMMAND_ROUTES)) {
      // The pre-Tier-A routes have their own cases above.
      if (
        ['switch', 'lock-control', 'brightness', 'alarm-panel', 'button', 'control'].includes(cap)
      )
        continue
      if (route.primary !== undefined && !tested.has(`${cap}:`)) untested.push(cap)
      for (const suffix of Object.keys(route.extras ?? {})) {
        if (!tested.has(`${cap}:${suffix}`)) untested.push(`${cap}.${suffix}`)
      }
      for (const suffix of Object.keys(route.commands ?? {})) {
        if (!tested.has(`${cap}:!${suffix}`)) untested.push(`${cap}!${suffix}`)
      }
    }
    expect(untested).toEqual([])
  })

  /**
   * `lockControl.open` — the LATCH, which is neither `lock` nor `unlock`.
   * Home Assistant spells it `LockEntityFeature.OPEN`; the cap has declared
   * the method since it was written, and until 2026-08-14 nothing routed
   * it, so the native lock's `open` control resolved to no entity and was
   * silently skipped on every build.
   */
  it('routes the lock latch to lockControl.open, never to unlock', async () => {
    const target: CommandTarget = {
      deviceId: 900,
      type: 'lock',
      boundCaps: ['lock-control'],
    }
    const calls: RecordedCall[] = []
    const outcome = await applyCapCommand(
      recordingDevice(calls),
      commandFor(target, 'lock_control_open', 'PRESS'),
    )
    expect(outcome).toEqual({ ok: true })
    expect(calls).toEqual([{ method: 'lockControl.open', input: {} }])
  })

  it('surfaces a lock with no latch as the provider’s refusal, not as success', async () => {
    const target: CommandTarget = {
      deviceId: 900,
      type: 'lock',
      boundCaps: ['lock-control'],
    }
    const device: CapCommandDevice = {
      lockControl: {
        lock: async () => {},
        unlock: async () => {},
        open: async () => {
          throw new Error('This lock has no latch')
        },
        getStatus: async () => null,
      },
    }
    expect(await applyCapCommand(device, commandFor(target, 'lock_control_open', 'PRESS'))).toEqual(
      {
        ok: false,
        reason: 'refused',
        capName: 'lock-control',
        error: 'This lock has no latch',
      },
    )
  })

  /**
   * The dual setpoint. Home Assistant sends the two edges on two topics and
   * `setTargetRange` takes both, so the command carries the edge it was
   * given and the DISPATCH reads the other one off the device. One call
   * reaches the cap, carrying both.
   */
  describe('the dual setpoint', () => {
    /**
     * The status a thermostat reports, as the cap declares it. Built from
     * the schema's own defaults rather than a hand-written subset: a fake
     * that supplied only the two fields the code reads would pass whether or
     * not production asked for the right ones.
     */
    function statusWith(targetLow: number | null, targetHigh: number | null): ClimateControlStatus {
      return {
        mode: 'heat_cool',
        availableModes: ['heat_cool'],
        fanMode: '',
        availableFanModes: [],
        preset: '',
        availablePresets: [],
        currentTemp: 21,
        currentHumidity: null,
        target: null,
        targetLow,
        targetHigh,
        targetHumidity: null,
        swingVertical: null,
        swingHorizontal: null,
        lastFetchedAt: 0,
      }
    }

    function thermostat(
      calls: RecordedCall[],
      status: ClimateControlStatus | null,
    ): CapCommandDevice {
      const base = recordingDevice(calls)
      const climate = base.climateControl
      if (climate === undefined) throw new Error('the recording device lost its climate slice')
      return {
        ...base,
        climateControl: { ...climate, getStatus: async () => status },
      }
    }

    const target: CommandTarget = {
      deviceId: 900,
      type: 'thermostat',
      boundCaps: ['climate-control'],
    }

    it('preserves the other edge and calls setTargetRange once', async () => {
      const calls: RecordedCall[] = []
      const outcome = await applyCapCommand(
        thermostat(calls, statusWith(18, 24)),
        commandFor(target, 'climate_control_target_low', '19.5'),
      )
      expect(outcome).toEqual({ ok: true })
      expect(calls).toEqual([
        {
          method: 'climateControl.setTargetRange',
          input: { targetLow: 19.5, targetHigh: 24 },
        },
      ])
    })

    it('writes the high edge the same way', async () => {
      const calls: RecordedCall[] = []
      await applyCapCommand(
        thermostat(calls, statusWith(18, 24)),
        commandFor(target, 'climate_control_target_high', '26'),
      )
      expect(calls).toEqual([
        {
          method: 'climateControl.setTargetRange',
          input: { targetLow: 18, targetHigh: 26 },
        },
      ])
    })

    /**
     * A device with no range has nothing to move one edge of. Substituting
     * the single `target`, or the edge itself, would silently collapse the
     * band to a point — which is a thermostat told to hold 19.5 to 19.5.
     */
    it('refuses rather than inventing the edge the device does not report', async () => {
      const calls: RecordedCall[] = []
      const outcome = await applyCapCommand(
        thermostat(calls, statusWith(18, null)),
        commandFor(target, 'climate_control_target_low', '19.5'),
      )
      expect(outcome.ok).toBe(false)
      expect(calls).toEqual([])
    })

    it('refuses when the device reports no status at all', async () => {
      const calls: RecordedCall[] = []
      const outcome = await applyCapCommand(
        thermostat(calls, null),
        commandFor(target, 'climate_control_target_high', '26'),
      )
      expect(outcome.ok).toBe(false)
      expect(calls).toEqual([])
    })
  })

  it('refuses a Tier A payload the platform cannot carry', () => {
    const cover: CommandTarget = {
      deviceId: 900,
      type: 'cover',
      boundCaps: ['cover'],
    }
    expect(resolveCommand(cover, 'cover_position', '101')).toEqual({
      ok: false,
      reason: 'bad-value',
      capName: 'cover',
    })
    const climate: CommandTarget = {
      deviceId: 901,
      type: 'thermostat',
      boundCaps: ['climate-control'],
    }
    expect(resolveCommand(climate, 'climate_control', 'turbo')).toEqual({
      ok: false,
      reason: 'bad-value',
      capName: 'climate-control',
    })
    const color: CommandTarget = {
      deviceId: 902,
      type: 'light',
      boundCaps: ['color'],
    }
    // `ColorInputSchema` declares mireds as an INT — 370.5 is not one.
    expect(resolveCommand(color, 'color_mireds', '370.5')).toEqual({
      ok: false,
      reason: 'bad-value',
      capName: 'color',
    })
  })

  it('refuses a Tier A command on a device that does not declare the capability', () => {
    const target: CommandTarget = {
      deviceId: 900,
      type: 'cover',
      boundCaps: [],
    }
    expect(resolveCommand(target, 'cover_open', 'PRESS')).toEqual({
      ok: false,
      reason: 'cap-not-bound',
      capName: 'cover',
    })
    expect(resolveCommand(target, 'cover_position', '50')).toEqual({
      ok: false,
      reason: 'cap-not-bound',
      capName: 'cover',
    })
  })

  /**
   * What is STILL read-only, and each is a property of the value rather
   * than a gap in the table: talk-back is an audio stream a boolean cannot
   * open, and a colour MODE cannot be written on its own because
   * `setColor` takes a colour. The free-form vocabularies and the dual
   * setpoint left this list on 2026-08-14 — they are routed above.
   */
  it('refuses the entities Tier A deliberately left read-only', () => {
    const cases: readonly { readonly cap: string; readonly entity: string }[] = [
      { cap: 'intercom', entity: 'intercom' },
      { cap: 'color', entity: 'color' },
      { cap: 'cover', entity: 'cover' },
      { cap: 'vacuum-control', entity: 'vacuum_control' },
    ]
    for (const { cap, entity } of cases) {
      const target: CommandTarget = {
        deviceId: 900,
        type: 'generic',
        boundCaps: [cap],
      }
      expect(resolveCommand(target, entity, 'true'), entity).toEqual({
        ok: false,
        reason: 'not-writable',
        capName: cap,
      })
    }
  })

  /**
   * The contract, over EVERY entity a capability produces rather than only
   * its primary: a writable descriptor either names a route or is refused
   * with `no-route` and logged. Nothing may reach another capability's
   * method.
   *
   * Neutralisation check for this file: delete any one entry from
   * `CAP_COMMAND_ROUTES` and this case turns red on that entity — which is
   * the whole point, because without it a deleted route is indistinguishable
   * from a control that never existed.
   */
  it('names a route for every writable entity it can resolve, or refuses it', () => {
    for (const capName of Object.keys(CAP_ENTITY_MAP)) {
      const target: CommandTarget = {
        deviceId: 900,
        type: 'generic',
        boundCaps: [capName],
      }
      for (const ref of capEntities(capName)) {
        if (ref.descriptor.writable !== true) continue
        const isPrimary = ref.entity === derivedEntityId(capName)
        const suffix = isPrimary
          ? undefined
          : Object.keys(CAP_ENTITY_MAP[capName]?.extras ?? {}).find(
              (key) => derivedExtraEntityId(capName, key) === ref.entity,
            )
        const routed = isPrimary
          ? hasCommandRoute(capName)
          : suffix !== undefined && hasExtraCommandRoute(capName, suffix)
        if (routed) continue
        expect(resolveCommand(target, ref.entity, 'true'), ref.entity).toEqual({
          ok: false,
          reason: 'no-route',
          capName,
        })
      }
      for (const ref of capCommandEntities(capName)) {
        if (hasButtonCommandRoute(capName, ref.suffix)) continue
        expect(resolveCommand(target, ref.entity, 'PRESS'), ref.entity).toEqual({
          ok: false,
          reason: 'no-route',
          capName,
        })
      }
    }
  })
})

describe('applyCapCommand', () => {
  it('calls the method the capability declares, one per writable cap', async () => {
    const cases: readonly {
      readonly command: CapExportCommand
      readonly method: string
    }[] = [
      {
        command: commandFor(SWITCH, 'switch', 'true'),
        method: 'switch.setState',
      },
      {
        command: commandFor(
          { deviceId: 800, type: 'lock', boundCaps: ['lock-control'] },
          'lock_control',
          'true',
        ),
        method: 'lockControl.lock',
      },
      {
        command: commandFor(
          { deviceId: 800, type: 'lock', boundCaps: ['lock-control'] },
          'lock_control',
          'false',
        ),
        method: 'lockControl.unlock',
      },
      {
        command: commandFor(
          { deviceId: 810, type: 'light', boundCaps: ['brightness'] },
          'brightness',
          '42',
        ),
        method: 'brightness.setBrightness',
      },
      {
        command: commandFor(
          { deviceId: 820, type: 'alarm-panel', boundCaps: ['alarm-panel'] },
          'alarm_panel',
          'ARM_AWAY',
        ),
        method: 'alarmPanel.arm',
      },
      {
        command: commandFor(
          { deviceId: 820, type: 'alarm-panel', boundCaps: ['alarm-panel'] },
          'alarm_panel',
          'DISARM',
        ),
        method: 'alarmPanel.disarm',
      },
      {
        command: commandFor(
          { deviceId: 830, type: 'button', boundCaps: ['button'] },
          'button',
          'PRESS',
        ),
        method: 'button.press',
      },
    ]
    for (const { command, method } of cases) {
      const calls: RecordedCall[] = []
      const outcome = await applyCapCommand(recordingDevice(calls), command)
      expect(outcome, method).toEqual({ ok: true })
      expect(
        calls.map((call) => call.method),
        method,
      ).toEqual([method])
    }
  })

  it('passes the value through, not just the method name', async () => {
    const calls: RecordedCall[] = []
    await applyCapCommand(
      recordingDevice(calls),
      commandFor({ deviceId: 810, type: 'light', boundCaps: ['brightness'] }, 'brightness', '42'),
    )
    expect(calls).toEqual([{ method: 'brightness.setBrightness', input: { level: 42 } }])

    const armCalls: RecordedCall[] = []
    await applyCapCommand(
      recordingDevice(armCalls),
      commandFor(
        { deviceId: 820, type: 'alarm-panel', boundCaps: ['alarm-panel'] },
        'alarm_panel',
        'ARM_NIGHT',
      ),
    )
    expect(armCalls).toEqual([{ method: 'alarmPanel.arm', input: { mode: 'night' } }])
  })

  it('never touches switch.setState for a lock, a light or a panel', async () => {
    for (const command of [
      commandFor(
        { deviceId: 800, type: 'lock', boundCaps: ['lock-control'] },
        'lock_control',
        'true',
      ),
      commandFor({ deviceId: 810, type: 'light', boundCaps: ['brightness'] }, 'brightness', '10'),
      commandFor(
        { deviceId: 820, type: 'alarm-panel', boundCaps: ['alarm-panel'] },
        'alarm_panel',
        'DISARM',
      ),
    ]) {
      const calls: RecordedCall[] = []
      await applyCapCommand(recordingDevice(calls), command)
      expect(calls.map((call) => call.method)).not.toContain('switch.setState')
    }
  })

  it('refuses when the device declares the capability but nothing serves it', async () => {
    const outcome = await applyCapCommand(
      {},
      commandFor(
        { deviceId: 800, type: 'lock', boundCaps: ['lock-control'] },
        'lock_control',
        'true',
      ),
    )
    expect(outcome).toEqual({
      ok: false,
      reason: 'no-provider',
      capName: 'lock-control',
    })
  })

  it('surfaces a REFUSED arm as a failure, never as a silent success', async () => {
    // CamStack's own panel throws `NcAlarmArmRefusedError` when a contact the
    // mode covers is open. Reporting success over it would leave Home
    // Assistant showing `armed_away` on a house with an open door.
    const device: CapCommandDevice = {
      alarmPanel: {
        arm: async () => {
          throw new Error('Cannot arm away: Front door is open')
        },
        disarm: async () => {},
        trigger: async () => {},
        getStatus: async () => null,
      },
    }
    const outcome = await applyCapCommand(
      device,
      commandFor(
        { deviceId: 820, type: 'alarm-panel', boundCaps: ['alarm-panel'] },
        'alarm_panel',
        'ARM_AWAY',
      ),
    )
    expect(outcome).toEqual({
      ok: false,
      reason: 'refused',
      capName: 'alarm-panel',
      error: 'Cannot arm away: Front door is open',
    })
  })
})
