/**
 * Logs → Diagnostics (`/system/logs?tab=diagnostics`): the armed windows and
 * the log channels the addons declare (diagnostic and debug), one of them
 * armed, one debug channel watched. Invented data only.
 */
import { defineFixtures } from './_define'
import { NOW, MINUTE } from './_time'

const CHANNELS = [
  {
    name: 'stream-broker.webrtc',
    description: 'WebRTC negotiation and ICE state per session.',
    defaultLevel: 'info',
    perDevice: true,
    kind: 'diagnostic',
  },
  {
    name: 'stream-broker.rtp',
    description: 'RTP packet pacing and loss counters.',
    defaultLevel: 'info',
    perDevice: true,
    kind: 'debug',
  },
  {
    name: 'provider-onvif.events',
    description: 'Raw ONVIF event payloads as the camera sent them.',
    defaultLevel: 'info',
    perDevice: true,
    kind: 'debug',
  },
  {
    name: 'recorder.retention',
    description: 'Why a recording segment was kept or evicted.',
    defaultLevel: 'info',
    perDevice: false,
    kind: 'diagnostic',
  },
]

const LOGGING = {
  scopeNodeId: null,
  scopeComponent: null,
  effective: {},
  explicit: {},
  activeWindows: [
    {
      id: 'request-census',
      armed: true,
      armedUntilMs: NOW + 4 * MINUTE,
      remainingMs: 4 * MINUTE,
      persisted: true,
    },
  ],
  channels: CHANNELS,
  activeChannels: [
    { channel: 'stream-broker.webrtc', armed: true, remainingMs: 7 * MINUTE, deviceIds: [101] },
  ],
  opsLogRetentionDays: 30,
  persisted: true,
}

export default defineFixtures({
  area: 'system-logging',
  description: 'Logs diagnostics: armed windows, declared channels, a debug watch',
  handlers: {
    'system.getLoggingSettings': LOGGING,
    'mut:system.debugWatch': {
      nowMs: NOW,
      watches: [
        {
          channel: 'stream-broker.rtp',
          deviceIds: [101],
          startedAtMs: NOW - 2 * MINUTE,
          untilMs: NOW + 8 * MINUTE,
          capAtMs: NOW + 58 * MINUTE,
        },
      ],
      lapsed: [],
    },
  },
})
