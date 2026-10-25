import { describe, it, expect } from 'vitest'
import {
  controlCapability,
  ControlStatusSchema,
  ControlKindSchema,
  notifierCapability,
  NotifierStatusSchema,
  mediaPlayerCapability,
  MediaPlayerStatusSchema,
  MediaPlayerStateSchema,
  MediaPlayerRepeatSchema,
  alarmPanelCapability,
  AlarmPanelStatusSchema,
  AlarmStateSchema,
  AlarmArmModeSchema,
  presenceCapability,
  PresenceStatusSchema,
  scriptRunnerCapability,
  ScriptRunnerStatusSchema,
  automationControlCapability,
  AutomationControlStatusSchema,
} from '../index.js'
import { DeviceType, DeviceFeature } from '../device/device-type.js'

describe('HA actuator caps — Phase C3', () => {
  describe('control cap', () => {
    it('registers as singleton device-scoped push cap on Control', () => {
      expect(controlCapability.name).toBe('control')
      expect(controlCapability.scope).toBe('device')
      expect(controlCapability.mode).toBe('singleton')
      expect(controlCapability.deviceTypes).toEqual([DeviceType.Control])
      expect(controlCapability.status.kind).toBe('push')
    })

    it('runtimeState mirrors the status schema', () => {
      expect(controlCapability.runtimeState).toBe(ControlStatusSchema)
    })

    it('exposes setValue as an protected mutation', () => {
      expect(controlCapability.methods.setValue.kind).toBe('mutation')
      expect(controlCapability.methods.setValue.auth).toBe('protected')
    })

    it('ControlKind covers numeric / select / text / datetime', () => {
      expect(ControlKindSchema.options).toEqual(['numeric', 'select', 'text', 'datetime'])
    })

    it('status accepts numeric kind with number value', () => {
      const sample = { kind: 'numeric' as const, value: 42.5, options: [], lastChangedAt: 1 }
      expect(ControlStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status accepts select kind with options populated', () => {
      const sample = {
        kind: 'select' as const,
        value: 'medium',
        options: ['low', 'medium', 'high'],
        lastChangedAt: 1,
      }
      expect(ControlStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status accepts datetime kind with ISO string', () => {
      const sample = {
        kind: 'datetime' as const,
        value: '2026-05-31T14:30:00Z',
        options: [],
        lastChangedAt: 1,
      }
      expect(ControlStatusSchema.parse(sample)).toEqual(sample)
    })

    it('setValue input accepts numeric discriminated branch', () => {
      const input = { deviceId: 7, control: { kind: 'numeric' as const, value: 21 } }
      expect(controlCapability.methods.setValue.input.parse(input)).toEqual(input)
    })

    it('setValue input rejects numeric branch with string value', () => {
      expect(() =>
        controlCapability.methods.setValue.input.parse({
          deviceId: 7,
          control: { kind: 'numeric', value: 'twenty-one' },
        }),
      ).toThrow()
    })

    it('setValue input rejects select branch with empty value', () => {
      expect(() =>
        controlCapability.methods.setValue.input.parse({
          deviceId: 7,
          control: { kind: 'select', value: '' },
        }),
      ).toThrow()
    })

    it('setValue input rejects unknown kind', () => {
      expect(() =>
        controlCapability.methods.setValue.input.parse({
          deviceId: 7,
          control: { kind: 'xyz', value: 0 },
        }),
      ).toThrow()
    })
  })

  describe('notifier cap', () => {
    it('registers as singleton device-scoped command-driven cap on Notifier', () => {
      expect(notifierCapability.name).toBe('notifier')
      expect(notifierCapability.scope).toBe('device')
      expect(notifierCapability.mode).toBe('singleton')
      expect(notifierCapability.deviceTypes).toEqual([DeviceType.Notifier])
      expect(notifierCapability.status.kind).toBe('command-driven')
    })

    it('runtimeState mirrors the status schema', () => {
      expect(notifierCapability.runtimeState).toBe(NotifierStatusSchema)
    })

    it('exposes send + cancel as admin mutations', () => {
      for (const name of ['send', 'cancel'] as const) {
        const m = notifierCapability.methods[name]
        expect(m.kind).toBe('mutation')
        expect(m.auth).toBe('admin')
      }
    })

    it('declares onSent event', () => {
      expect(notifierCapability.events).toBeDefined()
      expect(notifierCapability.events.onSent).toBeDefined()
    })

    it('send input accepts minimal {deviceId, body}', () => {
      const input = { deviceId: 7, body: 'hi' }
      expect(notifierCapability.methods.send.input.parse(input)).toMatchObject(input)
    })

    it('send input accepts rich payload', () => {
      const input = {
        deviceId: 7,
        title: 'Alert',
        body: 'Motion detected',
        image: 'https://cdn/snapshot.jpg',
        priority: 'high' as const,
        channel: 'security',
        recipients: ['user1', 'user2'],
        actions: [{ id: 'view', title: 'View', uri: 'app://camera/1' }],
        data: { custom: 'value' },
      }
      expect(notifierCapability.methods.send.input.parse(input)).toEqual(input)
    })

    it('send input rejects empty body', () => {
      expect(() => notifierCapability.methods.send.input.parse({ deviceId: 7, body: '' })).toThrow()
    })

    it('send input rejects unknown priority', () => {
      expect(() =>
        notifierCapability.methods.send.input.parse({
          deviceId: 7,
          body: 'hi',
          priority: 'urgent',
        }),
      ).toThrow()
    })

    it('cancel input requires notificationId', () => {
      expect(() => notifierCapability.methods.cancel.input.parse({ deviceId: 7 })).toThrow()
    })

    it('status accepts a fully-populated diagnostic sample', () => {
      const sample = {
        lastSentAt: 1700000000,
        lastError: null,
        queueDepth: 0,
        supports: {
          image: true,
          priority: true,
          data: true,
          actions: true,
          recipients: false,
        },
      }
      expect(NotifierStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status rejects negative queueDepth', () => {
      expect(() =>
        NotifierStatusSchema.parse({
          lastSentAt: 0,
          lastError: null,
          queueDepth: -1,
          supports: {
            image: false,
            priority: false,
            data: false,
            actions: false,
            recipients: false,
          },
        }),
      ).toThrow()
    })
  })

  describe('media-player cap', () => {
    it('registers as singleton device-scoped push cap on MediaPlayer', () => {
      expect(mediaPlayerCapability.name).toBe('media-player')
      expect(mediaPlayerCapability.scope).toBe('device')
      expect(mediaPlayerCapability.mode).toBe('singleton')
      expect(mediaPlayerCapability.deviceTypes).toEqual([DeviceType.MediaPlayer])
      expect(mediaPlayerCapability.status.kind).toBe('push')
    })

    it('runtimeState mirrors the status schema', () => {
      expect(mediaPlayerCapability.runtimeState).toBe(MediaPlayerStatusSchema)
    })

    it('exposes 12 method surfaces all as protected mutations', () => {
      const methodNames = [
        'play',
        'pause',
        'stop',
        'next',
        'previous',
        'seek',
        'setVolume',
        'setMute',
        'setShuffle',
        'setRepeat',
        'selectSource',
        'playMedia',
      ] as const
      for (const name of methodNames) {
        const m = mediaPlayerCapability.methods[name]
        expect(m.kind).toBe('mutation')
        expect(m.auth).toBe('protected')
      }
    })

    it('MediaPlayerState enum includes the canonical HA states', () => {
      const s = MediaPlayerStateSchema.options
      for (const expected of ['off', 'on', 'idle', 'playing', 'paused', 'buffering', 'standby']) {
        expect(s).toContain(expected)
      }
    })

    it('MediaPlayerRepeat enum is exactly off / all / one', () => {
      expect(MediaPlayerRepeatSchema.options).toEqual(['off', 'all', 'one'])
    })

    it('status accepts a fully-populated now-playing sample', () => {
      const sample = {
        state: 'playing' as const,
        volumeLevel: 60,
        isMuted: false,
        source: 'Spotify',
        availableSources: ['Spotify', 'TV', 'AUX'],
        currentMedia: {
          type: 'music',
          title: 'Track',
          artist: 'Artist',
          album: 'Album',
          imageUrl: 'https://cdn/cover.jpg',
        },
        positionMs: 12000,
        durationMs: 240000,
        shuffle: true,
        repeat: 'all' as const,
        lastChangedAt: 1,
      }
      expect(MediaPlayerStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status accepts a minimal off-state sample with nullables', () => {
      const sample = {
        state: 'off' as const,
        volumeLevel: null,
        isMuted: null,
        source: '',
        availableSources: [],
        currentMedia: null,
        positionMs: null,
        durationMs: null,
        shuffle: null,
        repeat: null,
        lastChangedAt: 0,
      }
      expect(MediaPlayerStatusSchema.parse(sample)).toEqual(sample)
    })

    it('seek rejects negative positionMs', () => {
      expect(() =>
        mediaPlayerCapability.methods.seek.input.parse({ deviceId: 1, positionMs: -1 }),
      ).toThrow()
    })

    it('playMedia requires both mediaId and mediaType', () => {
      expect(() =>
        mediaPlayerCapability.methods.playMedia.input.parse({ deviceId: 1, mediaId: 'x' }),
      ).toThrow()
    })
  })

  describe('alarm-panel cap', () => {
    it('registers as singleton device-scoped push cap on AlarmPanel', () => {
      expect(alarmPanelCapability.name).toBe('alarm-panel')
      expect(alarmPanelCapability.deviceTypes).toEqual([DeviceType.AlarmPanel])
      expect(alarmPanelCapability.status.kind).toBe('push')
    })

    it('runtimeState mirrors the status schema', () => {
      expect(alarmPanelCapability.runtimeState).toBe(AlarmPanelStatusSchema)
    })

    it('AlarmState covers the canonical lifecycle including jammed-style triggered/pending', () => {
      const states = AlarmStateSchema.options
      for (const expected of [
        'disarmed',
        'armed_home',
        'armed_away',
        'armed_night',
        'armed_vacation',
        'armed_custom_bypass',
        'arming',
        'disarming',
        'pending',
        'triggered',
      ]) {
        expect(states).toContain(expected)
      }
    })

    it('AlarmArmMode covers home / away / night / vacation / custom_bypass', () => {
      expect(AlarmArmModeSchema.options).toEqual([
        'home',
        'away',
        'night',
        'vacation',
        'custom_bypass',
      ])
    })

    it('arm accepts mode + optional code', () => {
      const input = { deviceId: 7, mode: 'away' as const, code: '1234' }
      expect(alarmPanelCapability.methods.arm.input.parse(input)).toEqual(input)
    })

    it('arm rejects unknown mode', () => {
      expect(() =>
        alarmPanelCapability.methods.arm.input.parse({ deviceId: 7, mode: 'panic' }),
      ).toThrow()
    })

    it('disarm accepts no code (default disarm)', () => {
      const input = { deviceId: 7 }
      expect(alarmPanelCapability.methods.disarm.input.parse(input)).toEqual(input)
    })

    it('status accepts a typical disarmed sample', () => {
      const sample = {
        state: 'disarmed' as const,
        targetMode: null,
        availableModes: ['home', 'away', 'night'] as const,
        requiresCode: true,
        lastChangedAt: 1,
      }
      expect(AlarmPanelStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status accepts a pending sample that names the armed mode', () => {
      const sample = {
        state: 'pending' as const,
        targetMode: 'night' as const,
        availableModes: ['home', 'away', 'night'] as const,
        requiresCode: false,
        lastChangedAt: 1,
      }
      expect(AlarmPanelStatusSchema.parse(sample)).toEqual(sample)
    })
  })

  describe('presence cap', () => {
    it('registers as singleton device-scoped push cap on Presence', () => {
      expect(presenceCapability.name).toBe('presence')
      expect(presenceCapability.deviceTypes).toEqual([DeviceType.Presence])
      expect(presenceCapability.status.kind).toBe('push')
    })

    it('is read-only — no methods declared', () => {
      expect(Object.keys(presenceCapability.methods)).toEqual([])
    })

    it('runtimeState mirrors the status schema', () => {
      expect(presenceCapability.runtimeState).toBe(PresenceStatusSchema)
    })

    it('status accepts a full GPS sample', () => {
      const sample = {
        state: 'home',
        location: 'Living Room',
        gps: { latitude: 41.9, longitude: 12.5, accuracyMeters: 8 },
        batteryPercent: 85,
        lastChangedAt: 1,
      }
      expect(PresenceStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status accepts a minimal GPS-less sample', () => {
      const sample = {
        state: 'not_home',
        location: null,
        gps: null,
        batteryPercent: null,
        lastChangedAt: 0,
      }
      expect(PresenceStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status rejects latitude out of -90..90', () => {
      expect(() =>
        PresenceStatusSchema.parse({
          state: 'home',
          location: null,
          gps: { latitude: 95, longitude: 0, accuracyMeters: 1 },
          batteryPercent: null,
          lastChangedAt: 0,
        }),
      ).toThrow()
    })
  })

  describe('script-runner cap', () => {
    it('registers as singleton device-scoped push cap on Script', () => {
      expect(scriptRunnerCapability.name).toBe('script-runner')
      expect(scriptRunnerCapability.deviceTypes).toEqual([DeviceType.Script])
      expect(scriptRunnerCapability.status.kind).toBe('push')
    })

    it('runtimeState mirrors the status schema', () => {
      expect(scriptRunnerCapability.runtimeState).toBe(ScriptRunnerStatusSchema)
    })

    it('exposes run + stop as admin mutations', () => {
      for (const name of ['run', 'stop'] as const) {
        const m = scriptRunnerCapability.methods[name]
        expect(m.kind).toBe('mutation')
        expect(m.auth).toBe('admin')
      }
    })

    it('run accepts optional variables map', () => {
      const input = { deviceId: 7, variables: { duration: 30, mode: 'silent' } }
      expect(scriptRunnerCapability.methods.run.input.parse(input)).toEqual(input)
    })

    it('run accepts no variables (plain trigger)', () => {
      const input = { deviceId: 7 }
      expect(scriptRunnerCapability.methods.run.input.parse(input)).toEqual(input)
    })

    it('status accepts a typical idle sample', () => {
      const sample = {
        isRunning: false,
        lastRunAt: 1700000000,
        lastRunSuccess: true,
        lastError: null,
        lastChangedAt: 1,
      }
      expect(ScriptRunnerStatusSchema.parse(sample)).toEqual(sample)
    })
  })

  describe('automation-control cap', () => {
    it('registers as singleton device-scoped push cap on Automation', () => {
      expect(automationControlCapability.name).toBe('automation-control')
      expect(automationControlCapability.deviceTypes).toEqual([DeviceType.Automation])
      expect(automationControlCapability.status.kind).toBe('push')
    })

    it('runtimeState mirrors the status schema', () => {
      expect(automationControlCapability.runtimeState).toBe(AutomationControlStatusSchema)
    })

    it('exposes enable + disable + trigger as admin mutations', () => {
      for (const name of ['enable', 'disable', 'trigger'] as const) {
        const m = automationControlCapability.methods[name]
        expect(m.kind).toBe('mutation')
        expect(m.auth).toBe('admin')
      }
    })

    it('trigger accepts optional skipCondition flag', () => {
      const input = { deviceId: 7, skipCondition: true }
      expect(automationControlCapability.methods.trigger.input.parse(input)).toEqual(input)
    })

    it('trigger accepts plain {deviceId} without skipCondition', () => {
      const input = { deviceId: 7 }
      expect(automationControlCapability.methods.trigger.input.parse(input)).toEqual(input)
    })

    it('status accepts a typical enabled-and-idle sample', () => {
      const sample = {
        enabled: true,
        isRunning: false,
        lastTriggeredAt: 1700000000,
        lastError: null,
        lastChangedAt: 1,
      }
      expect(AutomationControlStatusSchema.parse(sample)).toEqual(sample)
    })
  })

  describe('DeviceFeature additions (Phase C3 sub-feature flags)', () => {
    it('all C3 sub-feature flags are present on the DeviceFeature enum', () => {
      const expected: string[] = [
        DeviceFeature.MediaPlayerSeek,
        DeviceFeature.MediaPlayerVolume,
        DeviceFeature.MediaPlayerMute,
        DeviceFeature.MediaPlayerShuffle,
        DeviceFeature.MediaPlayerRepeat,
        DeviceFeature.MediaPlayerSelectSource,
        DeviceFeature.MediaPlayerPlayMedia,
        DeviceFeature.MediaPlayerNext,
        DeviceFeature.MediaPlayerPrevious,
        DeviceFeature.MediaPlayerStop,
        DeviceFeature.AlarmPinRequired,
        DeviceFeature.PresenceGps,
        DeviceFeature.NotifierImage,
        DeviceFeature.NotifierPriority,
        DeviceFeature.NotifierData,
        DeviceFeature.NotifierActions,
        DeviceFeature.NotifierRecipients,
        DeviceFeature.ScriptVariables,
        DeviceFeature.AutomationSkipCondition,
      ]
      expect(expected.every((v) => typeof v === 'string' && v.length > 0)).toBe(true)
      // unique
      expect(new Set(expected).size).toBe(expected.length)
    })
  })

  describe('cross-cap invariants', () => {
    it('all 7 Phase C3 caps target distinct DeviceTypes', () => {
      const types = new Set<string>([
        ...controlCapability.deviceTypes,
        ...notifierCapability.deviceTypes,
        ...mediaPlayerCapability.deviceTypes,
        ...alarmPanelCapability.deviceTypes,
        ...presenceCapability.deviceTypes,
        ...scriptRunnerCapability.deviceTypes,
        ...automationControlCapability.deviceTypes,
      ])
      expect(types.size).toBe(7)
    })

    it('cap names are unique', () => {
      const names = new Set([
        controlCapability.name,
        notifierCapability.name,
        mediaPlayerCapability.name,
        alarmPanelCapability.name,
        presenceCapability.name,
        scriptRunnerCapability.name,
        automationControlCapability.name,
      ])
      expect(names.size).toBe(7)
    })
  })
})
