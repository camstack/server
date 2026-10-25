/**
 * Cameras and the platform caps a device carries: PTZ, privacy, day/night,
 * detection and tracking, recording, streams, and the plumbing an operator
 * never actuates from an automation (each with the reason).
 */
import { EventCategory } from '../../../enums/event-category.js'
import { t } from '../l10n.js'
import type { CapVocabularySlice } from '../types.js'

type CameraCap =
  | 'accessories'
  | 'audio-analysis'
  | 'audio-metrics'
  | 'camera-credentials'
  | 'camera-grid-layout'
  | 'camera-pipeline-config'
  | 'camera-streams'
  | 'day-night'
  | 'detection-pipeline'
  | 'device-admin-link'
  | 'device-discovery'
  | 'device-extension'
  | 'device-ops'
  | 'feature-probe'
  | 'image'
  | 'image-settings'
  | 'intercom'
  | 'motion-detection'
  | 'motion-zones'
  | 'native-object-detection'
  | 'osd'
  | 'pipeline-analytics'
  | 'privacy-mask'
  | 'ptz'
  | 'ptz-autotrack'
  | 'reboot'
  | 'recording'
  | 'recording-onboard'
  | 'recording-signal'
  | 'scene-monitor'
  | 'snapshot'
  | 'stream-catalog'
  | 'stream-params'
  | 'stream-signals'
  | 'videoclips'
  | 'webrtc-session'
  | 'zone-analytics'
  | 'zone-rules'
  | 'zones'

const STREAM_PLUMBING = 'live-stream session plumbing driven by a viewer, never a discrete step'

/** The camera and platform family of the vocabulary. */
export const CAMERA_CAP_VOCABULARY: CapVocabularySlice<CameraCap> = {
  accessories: {
    scope: 'device',
    noun: t('Accessories', 'Accessori'),
    events: {
      onAccessoriesChanged: {
        notOperatorFacing: 'the device’s child list changed — administration, not a happening',
      },
      onChildVisibilityChanged: {
        notOperatorFacing: 'an operator hid or showed a child — administration, not a happening',
      },
    },
  },

  'audio-analysis': {
    scope: 'device',
    noun: t('Audio analysis', 'Analisi audio'),
    events: {
      onAudioLevel: {
        notOperatorFacing:
          'a sound-level sample at stream rate; loud-noise rules belong to the detection pipeline',
      },
    },
  },

  'audio-metrics': {
    scope: 'device',
    noun: t('Audio metrics', 'Metriche audio'),
  },
  'camera-credentials': {
    scope: 'device',
    noun: t('Camera credentials', 'Credenziali della telecamera'),
  },
  'camera-grid-layout': {
    scope: 'device',
    noun: t('Grid layout', 'Layout a griglia'),
  },
  'camera-pipeline-config': {
    scope: 'device',
    noun: t('Detection settings', 'Impostazioni di rilevamento'),
  },

  'camera-streams': {
    scope: 'device',
    noun: t('Camera streams', 'Flussi della telecamera'),
    events: {
      onCamStreamsChanged: {
        notOperatorFacing: 'the stream catalog was rebuilt — plumbing, not a happening',
      },
      onProfileSlotsChanged: {
        notOperatorFacing: 'stream profiles were reassigned — plumbing, not a happening',
      },
    },
  },

  'day-night': {
    scope: 'device',
    noun: t('Day/night', 'Giorno/notte'),
    actions: [
      {
        id: 'dayNight.auto',
        method: 'setSettings',
        label: t('Day/night auto', 'Giorno/notte automatico'),
        phrase: t(
          'Let {device} switch day and night by itself',
          'Fai passare {device} da giorno a notte in automatico',
        ),
        icon: 'sun-moon',
        args: { settings: { mode: 'auto' } },
      },
      {
        id: 'dayNight.day',
        method: 'setSettings',
        label: t('Day mode', 'Modalità giorno'),
        phrase: t('Force {device} into day mode', 'Forza {device} in modalità giorno'),
        icon: 'sun',
        args: { settings: { mode: 'day' } },
      },
      {
        id: 'dayNight.night',
        method: 'setSettings',
        label: t('Night mode', 'Modalità notte'),
        phrase: t('Force {device} into night mode', 'Forza {device} in modalità notte'),
        icon: 'moon',
        args: { settings: { mode: 'night' } },
      },
    ],
    state: [
      {
        kind: 'enum',
        field: 'mode',
        label: t('Day/night mode', 'Modalità giorno/notte'),
        values: [
          { value: 'auto', label: t('Automatic', 'Automatica') },
          {
            value: 'day',
            label: t('Day', 'Giorno'),
            phrase: t(
              'When {device} switches to day mode',
              'Quando {device} passa in modalità giorno',
            ),
          },
          {
            value: 'night',
            label: t('Night', 'Notte'),
            phrase: t(
              'When {device} switches to night mode',
              'Quando {device} passa in modalità notte',
            ),
          },
          { value: 'schedule', label: t('Scheduled', 'Programmata') },
        ],
        icon: 'sun-moon',
      },
    ],
  },

  'detection-pipeline': {
    scope: 'device',
    noun: t('Detection pipeline', 'Pipeline di rilevamento'),
  },
  'device-admin-link': {
    scope: 'device',
    noun: t('Admin link', 'Link di amministrazione'),
  },
  'device-discovery': {
    scope: 'device',
    noun: t('Discovery', 'Rilevamento dispositivi'),
  },
  'device-extension': {
    scope: 'device',
    noun: t('Device extension', 'Estensione del dispositivo'),
  },

  'device-ops': {
    scope: 'device',
    noun: t('Device operations', 'Operazioni del dispositivo'),
    notOperatorFacing: {
      runAction:
        'a provider-defined custom action whose id and input only the addon knows; it reaches the picker through the custom-actions surface, not a fixed phrase',
    },
  },

  'feature-probe': {
    scope: 'device',
    noun: t('Feature probe', 'Rilevamento funzioni'),
    events: {
      onProbeChanged: {
        notOperatorFacing: 'the device’s capabilities were re-probed — plumbing, not a happening',
      },
    },
  },

  image: { scope: 'device', noun: t('Image', 'Immagine') },
  'image-settings': {
    scope: 'device',
    noun: t('Image settings', 'Impostazioni immagine'),
  },

  intercom: {
    scope: 'device',
    noun: t('Intercom', 'Citofono'),
    notOperatorFacing: {
      startSession: STREAM_PLUMBING,
      handleAnswer: STREAM_PLUMBING,
      stopSession: STREAM_PLUMBING,
      startTalkSession:
        'two-way talk is a person speaking through the viewer, not an automation step',
      pushTalkAudio: STREAM_PLUMBING,
      endTalkSession: STREAM_PLUMBING,
    },
    state: [
      {
        kind: 'boolean',
        field: 'talking',
        label: t('Talking', 'In conversazione'),
        whenTrue: t(
          'When someone starts talking through {device}',
          'Quando qualcuno inizia a parlare tramite {device}',
        ),
        whenFalse: t(
          'When the conversation on {device} ends',
          'Quando la conversazione su {device} finisce',
        ),
        icon: 'mic',
      },
    ],
    events: {
      onStatusChanged: {
        notOperatorFacing: 'the `talking` state trigger phrases both edges of this change',
      },
    },
  },

  'motion-detection': {
    scope: 'device',
    noun: t('Motion analysis', 'Analisi del movimento'),
    notOperatorFacing: {
      analyze: 'the pipeline feeds it frames — an internal stage, never called by a person',
      removeCamera: 'pipeline housekeeping when a camera leaves',
      reset: 'pipeline housekeeping',
    },
    events: {
      onMotion: {
        notOperatorFacing:
          'the analyzer’s raw verdict; the operator signal is the `motion` cap’s `detected` state',
      },
    },
  },

  'motion-zones': {
    scope: 'device',
    noun: t('Motion zones', 'Zone di movimento'),
  },

  'native-object-detection': {
    scope: 'device',
    noun: t('On-camera detection', 'Rilevamento a bordo'),
    actions: [
      {
        id: 'nativeDetection.on',
        method: 'setEnabled',
        label: t('On-camera detection on', 'Rilevamento a bordo attivo'),
        phrase: t(
          'Turn on the on-camera detection of {device}',
          'Attiva il rilevamento a bordo di {device}',
        ),
        icon: 'scan-eye',
        args: { enabled: true },
      },
      {
        id: 'nativeDetection.off',
        method: 'setEnabled',
        label: t('On-camera detection off', 'Rilevamento a bordo spento'),
        phrase: t(
          'Turn off the on-camera detection of {device}',
          'Disattiva il rilevamento a bordo di {device}',
        ),
        icon: 'scan-eye',
        args: { enabled: false },
      },
    ],
    state: [
      {
        kind: 'boolean',
        field: 'enabled',
        label: t('On-camera detection', 'Rilevamento a bordo'),
        whenTrue: t(
          'When the on-camera detection of {device} is turned on',
          'Quando si attiva il rilevamento a bordo di {device}',
        ),
        whenFalse: t(
          'When the on-camera detection of {device} is turned off',
          'Quando si disattiva il rilevamento a bordo di {device}',
        ),
        icon: 'scan-eye',
      },
    ],
    events: {
      onDetected: {
        category: EventCategory.DetectionCameraNative,
        label: t('Camera spotted something', 'La telecamera ha rilevato qualcosa'),
        phrase: t(
          'When {device} spots something with its own detector',
          'Quando {device} rileva qualcosa con il proprio rilevatore',
        ),
        icon: 'scan-eye',
      },
    },
  },

  osd: {
    scope: 'device',
    noun: t('On-screen text', 'Testo in sovrimpressione'),
    events: {
      onStatusChanged: {
        notOperatorFacing: 'an overlay setting changed — configuration, not a happening',
      },
    },
  },

  'pipeline-analytics': {
    scope: 'device',
    noun: t('Tracking', 'Tracciamento'),
    notOperatorFacing: {
      setTrackFlags: 'curating a recorded track in the review UI, not a live step',
      setTrackRelation: 'curating recorded tracks in the review UI, not a live step',
      clearTrackRelation: 'curating recorded tracks in the review UI, not a live step',
      setTrackPurity: 'curating a recorded track in the review UI, not a live step',
    },
    events: {
      onFrameTracked: {
        notOperatorFacing: 'one tracker frame — stream rate, never an automation trigger',
      },
      onTrackStarted: {
        category: EventCategory.PipelineAnalyticsTrackStarted,
        label: t('Subject appeared', 'Soggetto comparso'),
        phrase: t(
          'When {device} starts following a subject',
          'Quando {device} inizia a seguire un soggetto',
        ),
        icon: 'scan-eye',
      },
      onTrackEnded: {
        category: EventCategory.PipelineAnalyticsTrackEnded,
        label: t('Subject left', 'Soggetto uscito'),
        phrase: t(
          'When a subject leaves the view of {device}',
          'Quando un soggetto esce dall’inquadratura di {device}',
        ),
        icon: 'scan-eye',
      },
      onDetectionEvent: {
        category: EventCategory.PipelineAnalyticsDetectionEvent,
        label: t('Detection event', 'Evento di rilevamento'),
        phrase: t(
          'When {device} records a detection event',
          'Quando {device} registra un evento di rilevamento',
        ),
        icon: 'radar',
      },
    },
    extraEvents: [
      {
        category: EventCategory.PipelineAnalyticsPackageDelivered,
        label: t('Package delivered', 'Pacco consegnato'),
        phrase: t(
          'When a package is left in front of {device}',
          'Quando viene lasciato un pacco davanti a {device}',
        ),
        icon: 'package',
      },
      {
        category: EventCategory.PipelineAnalyticsPackagePickedUp,
        label: t('Package picked up', 'Pacco ritirato'),
        phrase: t(
          'When a package is picked up in front of {device}',
          'Quando viene ritirato un pacco davanti a {device}',
        ),
        icon: 'package-open',
      },
    ],
  },

  'privacy-mask': {
    scope: 'device',
    noun: t('Privacy', 'Privacy'),
    actions: [
      {
        id: 'privacy.maskOn',
        method: 'setMask',
        label: t('Privacy mask on', 'Maschera privacy attiva'),
        phrase: t('Cover the privacy zones of {device}', 'Oscura le zone private di {device}'),
        icon: 'eye-off',
        args: { patch: { enabled: true } },
      },
      {
        id: 'privacy.maskOff',
        method: 'setMask',
        label: t('Privacy mask off', 'Maschera privacy spenta'),
        phrase: t('Uncover the privacy zones of {device}', 'Scopri le zone private di {device}'),
        icon: 'eye',
        args: { patch: { enabled: false } },
      },
      {
        id: 'privacy.micOn',
        method: 'setAudioEnabled',
        label: t('Microphone on', 'Microfono attivo'),
        phrase: t('Turn on the microphone of {device}', 'Attiva il microfono di {device}'),
        icon: 'mic',
        args: { enabled: true },
      },
      {
        id: 'privacy.micOff',
        method: 'setAudioEnabled',
        label: t('Microphone off', 'Microfono spento'),
        phrase: t('Turn off the microphone of {device}', 'Disattiva il microfono di {device}'),
        icon: 'mic-off',
        args: { enabled: false },
      },
    ],
    state: [
      {
        kind: 'boolean',
        field: 'enabled',
        label: t('Privacy mask', 'Maschera privacy'),
        whenTrue: t(
          'When the privacy mask of {device} is turned on',
          'Quando si attiva la maschera privacy di {device}',
        ),
        whenFalse: t(
          'When the privacy mask of {device} is turned off',
          'Quando si disattiva la maschera privacy di {device}',
        ),
        icon: 'eye-off',
      },
      {
        kind: 'boolean',
        field: 'audioEnabled',
        label: t('Microphone', 'Microfono'),
        whenTrue: t(
          'When the microphone of {device} is turned on',
          'Quando si attiva il microfono di {device}',
        ),
        whenFalse: t(
          'When the microphone of {device} is turned off',
          'Quando si disattiva il microfono di {device}',
        ),
        icon: 'mic',
      },
    ],
  },

  ptz: {
    scope: 'device',
    noun: t('Pan / tilt / zoom', 'Brandeggio'),
    actions: [
      {
        id: 'ptz.goHome',
        method: 'goHome',
        label: t('PTZ go home', 'Torna alla posizione iniziale'),
        phrase: t('Send {device} to its home position', 'Riporta {device} alla posizione iniziale'),
        icon: 'house',
      },
      {
        id: 'ptz.goToPreset',
        method: 'goToPreset',
        label: t('PTZ go to preset', 'Vai a un preset'),
        phrase: t('Move {device} to {presetId}', 'Sposta {device} su {presetId}'),
        icon: 'move',
        openArgs: [
          {
            key: 'presetId',
            label: t('Preset', 'Preset'),
            offer: {
              kind: 'dynamic',
              from: 'method',
              method: 'getPresets',
              valueKey: 'id',
              labelKey: 'name',
            },
          },
        ],
      },
      {
        id: 'ptz.stop',
        method: 'stop',
        label: t('Stop moving', 'Ferma il movimento'),
        phrase: t('Stop {device} moving', 'Ferma il movimento di {device}'),
        icon: 'square',
      },
      {
        id: 'ptz.autofocusOn',
        method: 'setAutofocus',
        label: t('Autofocus on', 'Autofocus attivo'),
        phrase: t('Turn on autofocus on {device}', 'Attiva l’autofocus su {device}'),
        icon: 'focus',
        args: { enabled: true },
      },
      {
        id: 'ptz.autofocusOff',
        method: 'setAutofocus',
        label: t('Autofocus off', 'Autofocus spento'),
        phrase: t('Turn off autofocus on {device}', 'Disattiva l’autofocus su {device}'),
        icon: 'focus',
        args: { enabled: false },
      },
    ],
    notOperatorFacing: {
      move: 'a relative nudge from the live-view joystick; a fixed place is a preset',
      continuousMove: 'joystick motion held until released — continuous, not a discrete step',
    },
  },

  'ptz-autotrack': {
    scope: 'device',
    noun: t('Autotracking', 'Inseguimento automatico'),
    actions: [
      {
        id: 'ptz.autotrackOn',
        method: 'setEnabled',
        label: t('Autotrack on', 'Inseguimento attivo'),
        phrase: t('Start autotracking on {device}', 'Attiva l’inseguimento automatico su {device}'),
        icon: 'crosshair',
        args: { enabled: true },
      },
      {
        id: 'ptz.autotrackOff',
        method: 'setEnabled',
        label: t('Autotrack off', 'Inseguimento spento'),
        phrase: t(
          'Stop autotracking on {device}',
          'Disattiva l’inseguimento automatico su {device}',
        ),
        icon: 'crosshair',
        args: { enabled: false },
      },
    ],
    notOperatorFacing: {
      setSettings: 'tracking tuning (target type, delays) — set once on the camera’s PTZ page',
    },
    state: [
      {
        kind: 'boolean',
        field: 'enabled',
        label: t('Autotracking', 'Inseguimento automatico'),
        whenTrue: t(
          'When autotracking is turned on for {device}',
          'Quando si attiva l’inseguimento automatico di {device}',
        ),
        whenFalse: t(
          'When autotracking is turned off for {device}',
          'Quando si disattiva l’inseguimento automatico di {device}',
        ),
        icon: 'crosshair',
      },
    ],
    events: {
      onStatusChanged: {
        notOperatorFacing: 'the `enabled` state trigger phrases both edges of this change',
      },
    },
  },

  reboot: {
    scope: 'device',
    noun: t('Reboot', 'Riavvio'),
    actions: [
      {
        id: 'reboot.reboot',
        method: 'reboot',
        label: t('Reboot device', 'Riavvia il dispositivo'),
        phrase: t('Reboot {device}', 'Riavvia {device}'),
        icon: 'refresh-cw',
      },
    ],
  },

  recording: { scope: 'device', noun: t('Recording', 'Registrazione') },

  'recording-onboard': {
    scope: 'device',
    noun: t('On-camera recording', 'Registrazione a bordo'),
    actions: [
      {
        id: 'recordingOnboard.on',
        method: 'setSettings',
        label: t('On-camera recording on', 'Registrazione a bordo attiva'),
        phrase: t(
          'Turn on recording to the card of {device}',
          'Attiva la registrazione sulla scheda di {device}',
        ),
        icon: 'hard-drive',
        args: { settings: { enabled: true } },
      },
      {
        id: 'recordingOnboard.off',
        method: 'setSettings',
        label: t('On-camera recording off', 'Registrazione a bordo spenta'),
        phrase: t(
          'Turn off recording to the card of {device}',
          'Disattiva la registrazione sulla scheda di {device}',
        ),
        icon: 'hard-drive',
        args: { settings: { enabled: false } },
      },
    ],
    state: [
      {
        kind: 'boolean',
        field: 'recordingToNowhere',
        label: t('Recording to nowhere', 'Registra nel vuoto'),
        whenTrue: t(
          'When {device} is recording with no card to write to',
          'Quando {device} registra senza una scheda su cui scrivere',
        ),
        whenFalse: t(
          'When {device} has a card to record to again',
          'Quando {device} ha di nuovo una scheda su cui registrare',
        ),
        icon: 'hard-drive',
      },
    ],
  },

  'recording-signal': {
    scope: 'device',
    noun: t('Recording signal', 'Segnale di registrazione'),
    state: [
      {
        kind: 'boolean',
        field: 'active',
        label: t('Recording', 'In registrazione'),
        whenTrue: t('When {device} starts recording', 'Quando {device} inizia a registrare'),
        whenFalse: t('When {device} stops recording', 'Quando {device} smette di registrare'),
        icon: 'circle-dot',
      },
    ],
  },

  'scene-monitor': {
    scope: 'device',
    noun: t('Scene watch', 'Controllo della scena'),
    actions: [
      {
        id: 'sceneMonitor.recheck',
        method: 'recheckNow',
        label: t('Re-check a scene', 'Ricontrolla una scena'),
        phrase: t(
          'Re-check {monitorId} on {device} now',
          'Ricontrolla subito {monitorId} su {device}',
        ),
        icon: 'scan-search',
        openArgs: [
          {
            key: 'monitorId',
            label: t('Scene', 'Scena'),
            offer: {
              kind: 'dynamic',
              from: 'status',
              field: 'monitors',
              valueKey: 'id',
              labelKey: 'label',
            },
          },
        ],
      },
    ],
    extraEvents: [
      {
        category: EventCategory.EnrichmentSceneStateChanged,
        label: t('Scene changed', 'Scena cambiata'),
        phrase: t(
          'When a watched scene on {device} changes',
          'Quando cambia una scena controllata su {device}',
        ),
        icon: 'scan-search',
      },
    ],
  },

  snapshot: { scope: 'device', noun: t('Snapshot', 'Istantanea') },
  'stream-catalog': {
    scope: 'device',
    noun: t('Stream catalog', 'Catalogo dei flussi'),
  },
  'stream-params': {
    scope: 'device',
    noun: t('Stream parameters', 'Parametri dei flussi'),
  },
  'stream-signals': {
    scope: 'device',
    noun: t('Stream signals', 'Segnali dei flussi'),
  },
  videoclips: { scope: 'device', noun: t('Video clips', 'Clip video') },

  'webrtc-session': {
    scope: 'device',
    noun: t('Live session', 'Sessione live'),
    notOperatorFacing: {
      createSession: STREAM_PLUMBING,
      handleOffer: STREAM_PLUMBING,
      handleAnswer: STREAM_PLUMBING,
      addIceCandidate: STREAM_PLUMBING,
      closeSession: STREAM_PLUMBING,
      applyDownlinkProbe: STREAM_PLUMBING,
    },
  },

  'zone-analytics': {
    scope: 'device',
    noun: t('Zone occupancy', 'Occupazione delle zone'),
    extraEvents: [
      {
        category: EventCategory.ZoneAnalyticsOccupancyChanged,
        label: t('Zone occupancy changed', 'Occupazione della zona cambiata'),
        phrase: t(
          'When someone enters or leaves a zone of {device}',
          'Quando qualcuno entra o esce da una zona di {device}',
        ),
        icon: 'square-dashed',
      },
    ],
  },

  'zone-rules': { scope: 'device', noun: t('Zone rules', 'Regole delle zone') },
  zones: { scope: 'device', noun: t('Zones', 'Zone') },
}
