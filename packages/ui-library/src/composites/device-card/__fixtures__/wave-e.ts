/**
 * The `misc` page of the approved mockup (card-grid v39): button, update,
 * script, automation, control, event, image, notifier, gateway. A variant the
 * mockup draws but no cap declares (a button's last press, an update's
 * progress, a script parameter …) is not here.
 */
import type { AutomationCardModel, ButtonCardModel, ScriptCardModel } from '../scenes/action/model'
import type { ControlCardModel } from '../scenes/control/model'
import type { EventCardModel } from '../scenes/event/EventCard'
import type { GatewayCardModel } from '../scenes/gateway/GatewayCard'
import type { ImageCardModel } from '../scenes/image/ImageCard'
import type { NotifierCardModel } from '../scenes/notifier/NotifierCard'
import type { UpdateCardModel } from '../scenes/update/model'
import type { CardOrientation } from '../shell/model'
import { offline, readOnly } from './common'
import { deviceCommon } from './wave-d-common'

export interface WaveEFixture<M> {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: M
}

const ha = (name: string) => deviceCommon({ name, integration: 'Home Assistant' })
const v = <M>(
  id: string,
  caption: string,
  model: M,
  orientation: CardOrientation = 'vertical',
): WaveEFixture<M> => ({ id, caption, orientation, model })

export function buttonFixtures(): readonly WaveEFixture<ButtonCardModel>[] {
  return [
    v('button-gate', 'Pulsante', { common: ha('Apri cancello'), pressable: true }),
    v('button-router', 'Azione sensibile', {
      common: deviceCommon({ name: 'Riavvia router', integration: 'UniFi' }),
      pressable: true,
    }),
    v('button-readonly', 'Sola lettura', {
      common: readOnly(ha('Identifica lampada')),
      pressable: true,
    }),
    v(
      'button-horizontal',
      'Orizzontale',
      { common: ha('Apri cancello'), pressable: true },
      'horizontal',
    ),
  ]
}

const update = (
  name: string,
  integration: string,
  phase: UpdateCardModel['phase'],
  current: string,
  available: string | null,
): UpdateCardModel => ({
  common: deviceCommon({ name, integration }),
  phase,
  current,
  available,
  stateText: null,
  installable: true,
})

export function updateFixtures(): readonly WaveEFixture<UpdateCardModel>[] {
  return [
    v(
      'update-available',
      'Aggiornamento disponibile',
      update('Firmware termostato', 'Homematic', 'available', '2.4.10', '2.6.2'),
    ),
    v('update-installing', 'Installazione in corso', {
      ...update('Firmware presa', 'Shelly', 'installing', '1.3.2', '1.4.0'),
      stateText: 'DELIVER_FIRMWARE_IMAGE',
    }),
    v(
      'update-current',
      'Aggiornato',
      update('Firmware gateway', 'Velux', 'current', '0.2.0.0.71', '0.2.0.0.71'),
    ),
    v('update-offline', 'Offline', {
      ...update('Firmware sensore', 'Homematic', 'available', '1.0.4', '1.1.0'),
      common: offline(deviceCommon({ name: 'Firmware sensore', integration: 'Homematic' })),
    }),
    v(
      'update-horizontal',
      'Orizzontale',
      update('Firmware termostato', 'Homematic', 'available', '2.4.10', '2.6.2'),
      'horizontal',
    ),
  ]
}

export function scriptFixtures(): readonly WaveEFixture<ScriptCardModel>[] {
  const base: ScriptCardModel = {
    common: ha('Buonanotte'),
    running: false,
    lastRun: '9 h',
    lastError: null,
    runnable: true,
    stoppable: true,
  }
  return [
    v('script-ready', 'Script', base),
    v('script-running', 'In esecuzione', {
      ...base,
      common: ha('Scena cinema'),
      running: true,
      lastRun: '5 s',
    }),
    v('script-error', 'Ultima esecuzione fallita', {
      ...base,
      lastError: 'Servizio light.turn_off non trovato',
    }),
    v('script-never', 'Mai eseguito', { ...base, lastRun: null }),
  ]
}

export function automationFixtures(): readonly WaveEFixture<AutomationCardModel>[] {
  const base: AutomationCardModel = {
    common: ha('Luci al tramonto'),
    enabled: true,
    lastTriggered: '15 h',
    lastError: null,
    switchable: true,
    triggerable: true,
  }
  return [
    v('automation-on', 'Automazione attiva', base),
    v('automation-error', 'Ultima esecuzione fallita', {
      ...base,
      common: ha('Irrigazione mattino'),
      lastTriggered: '3 h',
      lastError: 'Ultima esecuzione fallita: valvola non raggiungibile',
    }),
    v('automation-off', 'Automazione disattivata', {
      ...base,
      common: ha('Vacanze'),
      enabled: false,
      lastTriggered: '3 g',
    }),
    v('automation-horizontal', 'Orizzontale', base, 'horizontal'),
  ]
}

export function controlFixtures(): readonly WaveEFixture<ControlCardModel>[] {
  return [
    v('control-number', 'Numero · min / max / passo', {
      common: ha('Soglia umidità'),
      control: { kind: 'numeric', value: 55, unit: '%', min: 30, max: 80, step: 1, precision: 0 },
      since: '1 g',
      settable: true,
    }),
    v('control-select', 'Scelta da una lista', {
      common: ha('Modalità casa'),
      control: {
        kind: 'select',
        value: 'In casa',
        options: ['In casa', 'Fuori', 'Notte', 'Vacanza'],
      },
      since: '2 h',
      settable: true,
    }),
    v('control-text', 'Testo', {
      common: ha('Messaggio display'),
      control: { kind: 'text', value: 'Bentornati' },
      since: '3 g',
      settable: true,
    }),
    v('control-date', 'Data e ora', {
      common: ha('Sveglia'),
      control: {
        kind: 'datetime',
        editor: 'datetime-local',
        value: '2026-11-12T06:45',
        shown: '12/11/2026, 06:45',
      },
      since: null,
      settable: true,
    }),
    v('control-readonly', 'Sola lettura', {
      common: readOnly(ha('Soglia umidità')),
      control: { kind: 'numeric', value: 55, unit: '%', min: 30, max: 80, step: 1, precision: 0 },
      since: '1 g',
      settable: true,
    }),
  ]
}

export function eventFixtures(): readonly WaveEFixture<EventCardModel>[] {
  return [
    v('event-vocabulary', 'Eventi · il vocabolario del dispositivo', {
      common: deviceCommon({ name: 'Pulsante comodino', integration: 'Shelly', battery: 88 }),
      last: { id: 'double', label: 'Doppio clic', since: '2 min' },
      entries: [
        { id: 'double', label: 'Doppio clic' },
        { id: 'single', label: 'Clic' },
        { id: 'long', label: 'Pressione lunga' },
      ],
    }),
    v('event-raw', 'Eventi grezzi', {
      common: deviceCommon({ name: 'Telecomando cucina', integration: 'Zigbee' }),
      last: { id: 'remote_button_short_press', label: 'remote_button_short_press', since: '5 s' },
      entries: [
        { id: 'remote_button_short_press', label: 'remote_button_short_press' },
        { id: 'remote_button_long_press', label: 'remote_button_long_press' },
      ],
    }),
    v('event-none', 'Nessun evento', {
      common: ha('Campanello'),
      last: null,
      entries: [{ id: 'ring', label: 'Squillo' }],
    }),
    v('event-sources', 'Eventi · un token per ogni tasto', {
      common: deviceCommon({ name: 'Telecomando soggiorno', integration: 'Homematic' }),
      last: { id: 'PRESS_SHORT', sourceId: '1', label: 'Pressione breve', since: '4 s' },
      entries: [
        { id: 'PRESS_SHORT', source: { id: '1', label: 'Tasto 1' }, label: 'Pressione breve' },
        { id: 'PRESS_LONG', source: { id: '1', label: 'Tasto 1' }, label: 'Pressione lunga' },
        { id: 'PRESS_SHORT', source: { id: '2', label: 'Tasto 2' }, label: 'Pressione breve' },
        { id: 'PRESS_LONG', source: { id: '2', label: 'Tasto 2' }, label: 'Pressione lunga' },
      ],
    }),
  ]
}

/** A neutral landscape picture, inline so the fixture loads no network file. */
const PICTURE =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNjAgOTAiPjxyZWN0IHdpZHRoPSIxNjAiIGhlaWdodD0iOTAiIGZpbGw9IiM5Y2EzYWYiIG9wYWNpdHk9IjAuMjUiLz48cGF0aCBkPSJNMCA5MCBMNTAgNDAgTDkwIDc1IEwxMjAgNTAgTDE2MCA5MCBaIiBmaWxsPSIjNmI3MjgwIiBvcGFjaXR5PSIwLjYiLz48L3N2Zz4='

export function imageFixtures(): readonly WaveEFixture<ImageCardModel>[] {
  return [
    v('image-shown', 'Immagine', { common: ha('Mappa robot'), url: PICTURE, updated: '5 min' }),
    v('image-none', 'Nessuna immagine', { common: ha('Mappa robot'), url: null, updated: null }),
  ]
}

export function notifierFixtures(): readonly WaveEFixture<NotifierCardModel>[] {
  const base: NotifierCardModel = {
    common: deviceCommon({ name: 'Telegram Gianluca', integration: 'Telegram' }),
    lastSent: '1 h',
    lastError: null,
    queued: 0,
    testable: true,
  }
  return [
    v('notifier-ready', 'Destinazione notifiche', base),
    v('notifier-failed', 'Consegna fallita', {
      ...base,
      common: deviceCommon({ name: 'Email famiglia', integration: 'SMTP' }),
      lastSent: '1 g',
      lastError: "Il server SMTP ha rifiutato l'accesso.",
      queued: 3,
    }),
  ]
}

export function gatewayFixtures(): readonly WaveEFixture<GatewayCardModel>[] {
  const base: GatewayCardModel = {
    common: deviceCommon({ name: 'Velux KLF-200', integration: 'Velux' }),
    facts: { model: 'KLF-200', firmware: '0.2.0.0.71', address: '192.168.1.40' },
    rebootable: true,
    adminLink: { url: 'https://192.168.1.40/', label: 'Pagina del gateway' },
  }
  return [
    v('gateway-connected', 'Gateway connesso', base),
    v('gateway-unreachable', 'Gateway non raggiungibile', {
      ...base,
      common: offline(deviceCommon({ name: 'Ecowitt GW2000', integration: 'Ecowitt' })),
      facts: { model: 'GW2000', firmware: '3.1.4', address: '192.168.1.44' },
      adminLink: null,
    }),
    v('gateway-horizontal', 'Orizzontale', base, 'horizontal'),
  ]
}
