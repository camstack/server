/**
 * Appliances, robots, media and scripted things: vacuums, mowers,
 * dishwashers, pet feeders, media players, consumables, scripts,
 * automations, notifiers and firmware updates.
 */
import { EventCategory } from '../../../enums/event-category.js'
import { t } from '../l10n.js'
import type { CapVocabularySlice } from '../types.js'

type ApplianceCap =
  | 'vacuum-control'
  | 'lawn-mower-control'
  | 'dishwasher'
  | 'pet-feeder'
  | 'media-player'
  | 'consumables'
  | 'running-state'
  | 'navigation'
  | 'script-runner'
  | 'automation-control'
  | 'notifier'
  | 'update'

const BATTERY_LEVEL = t('the battery level', 'il livello della batteria')

/** The appliance family of the vocabulary. */
export const APPLIANCE_CAP_VOCABULARY: CapVocabularySlice<ApplianceCap> = {
  'vacuum-control': {
    scope: 'device',
    noun: t('Robot vacuum', 'Robot aspirapolvere'),
    actions: [
      {
        id: 'vacuum.start',
        method: 'start',
        label: t('Start cleaning', 'Avvia la pulizia'),
        phrase: t('Start {device} cleaning', 'Fai partire la pulizia di {device}'),
        icon: 'play',
      },
      {
        id: 'vacuum.pause',
        method: 'pause',
        label: t('Pause', 'Metti in pausa'),
        phrase: t('Pause {device}', 'Metti in pausa {device}'),
        icon: 'pause',
      },
      {
        id: 'vacuum.stop',
        method: 'stop',
        label: t('Stop', 'Ferma'),
        phrase: t('Stop {device}', 'Ferma {device}'),
        icon: 'square',
      },
      {
        id: 'vacuum.dock',
        method: 'returnToBase',
        label: t('Return to base', 'Torna alla base'),
        phrase: t('Send {device} back to its base', 'Rimanda {device} alla base'),
        icon: 'house',
      },
      {
        id: 'vacuum.locate',
        method: 'locate',
        label: t('Locate', 'Trova'),
        phrase: t('Make {device} beep so you can find it', 'Fai suonare {device} per trovarlo'),
        icon: 'map-pin',
      },
      {
        id: 'vacuum.fanSpeed',
        method: 'setFanSpeed',
        label: t('Set suction', 'Imposta l’aspirazione'),
        phrase: t(
          'Set the suction of {device} to {speed}',
          'Imposta l’aspirazione di {device} su {speed}',
        ),
        icon: 'fan',
        openArgs: [
          {
            key: 'speed',
            label: t('Suction', 'Aspirazione'),
            offer: {
              kind: 'dynamic',
              from: 'status',
              field: 'availableFanSpeeds',
            },
          },
        ],
      },
    ],
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('Activity', 'Attività'),
        values: [
          { value: 'idle', label: t('Idle', 'Inattivo') },
          {
            value: 'cleaning',
            label: t('Cleaning', 'In pulizia'),
            phrase: t('When {device} starts cleaning', 'Quando {device} inizia a pulire'),
          },
          { value: 'paused', label: t('Paused', 'In pausa') },
          {
            value: 'returning',
            label: t('Returning', 'In rientro'),
            phrase: t('When {device} heads back to its base', 'Quando {device} torna alla base'),
          },
          {
            value: 'docked',
            label: t('Docked', 'Alla base'),
            phrase: t('When {device} docks', 'Quando {device} arriva alla base'),
          },
          { value: 'drying', label: t('Drying', 'In asciugatura') },
          {
            value: 'error',
            label: t('Error', 'Errore'),
            phrase: t('When {device} reports an error', 'Quando {device} segnala un errore'),
          },
        ],
        icon: 'bot',
      },
      {
        kind: 'numeric',
        field: 'batteryLevel',
        quantity: BATTERY_LEVEL,
        label: t('Battery', 'Batteria'),
        unit: '%',
        icon: 'battery',
      },
    ],
  },

  'lawn-mower-control': {
    scope: 'device',
    noun: t('Robot mower', 'Robot tosaerba'),
    actions: [
      {
        id: 'lawnMower.start',
        method: 'startMowing',
        label: t('Start mowing', 'Avvia il taglio'),
        phrase: t('Start {device} mowing', 'Fai partire il taglio di {device}'),
        icon: 'play',
      },
      {
        id: 'lawnMower.pause',
        method: 'pause',
        label: t('Pause mower', 'Metti in pausa il tosaerba'),
        phrase: t('Pause {device}', 'Metti in pausa {device}'),
        icon: 'pause',
      },
      {
        id: 'lawnMower.dock',
        method: 'dock',
        label: t('Dock mower', 'Riporta alla base'),
        phrase: t('Send {device} back to its dock', 'Rimanda {device} alla base'),
        icon: 'house',
      },
    ],
    state: [
      {
        kind: 'enum',
        field: 'activity',
        label: t('Activity', 'Attività'),
        values: [
          { value: 'idle', label: t('Idle', 'Inattivo') },
          {
            value: 'mowing',
            label: t('Mowing', 'In taglio'),
            phrase: t('When {device} starts mowing', 'Quando {device} inizia a tagliare'),
          },
          { value: 'paused', label: t('Paused', 'In pausa') },
          {
            value: 'docked',
            label: t('Docked', 'Alla base'),
            phrase: t('When {device} docks', 'Quando {device} arriva alla base'),
          },
          {
            value: 'error',
            label: t('Error', 'Errore'),
            phrase: t('When {device} reports an error', 'Quando {device} segnala un errore'),
          },
        ],
        icon: 'bot',
      },
      {
        kind: 'numeric',
        field: 'batteryLevel',
        quantity: BATTERY_LEVEL,
        label: t('Battery', 'Batteria'),
        unit: '%',
        icon: 'battery',
      },
    ],
  },

  dishwasher: {
    scope: 'device',
    noun: t('Dishwasher', 'Lavastoviglie'),
    actions: [
      {
        id: 'dishwasher.start',
        method: 'start',
        label: t('Start cycle', 'Avvia il lavaggio'),
        phrase: t('Start {device}', 'Avvia {device}'),
        icon: 'play',
        openArgs: [
          {
            key: 'program',
            label: t('Programme', 'Programma'),
            offer: {
              kind: 'dynamic',
              from: 'status',
              field: 'availablePrograms',
            },
            optional: true,
          },
        ],
      },
      {
        id: 'dishwasher.pause',
        method: 'pause',
        label: t('Pause', 'Metti in pausa'),
        phrase: t('Pause {device}', 'Metti in pausa {device}'),
        icon: 'pause',
      },
      {
        id: 'dishwasher.resume',
        method: 'resume',
        label: t('Resume', 'Riprendi'),
        phrase: t('Resume {device}', 'Riprendi il lavaggio di {device}'),
        icon: 'play',
      },
      {
        id: 'dishwasher.stop',
        method: 'stop',
        label: t('Stop', 'Ferma'),
        phrase: t('Stop {device}', 'Ferma {device}'),
        icon: 'square',
      },
      {
        id: 'dishwasher.program',
        method: 'setProgram',
        label: t('Choose programme', 'Scegli il programma'),
        phrase: t(
          'Select the {program} programme on {device}',
          'Seleziona il programma {program} su {device}',
        ),
        icon: 'list',
        openArgs: [
          {
            key: 'program',
            label: t('Programme', 'Programma'),
            offer: {
              kind: 'dynamic',
              from: 'status',
              field: 'availablePrograms',
            },
          },
        ],
      },
      {
        id: 'dishwasher.powerOn',
        method: 'setPower',
        label: t('Power on', 'Accendi'),
        phrase: t('Turn on {device}', 'Accendi {device}'),
        icon: 'power',
        args: { on: true },
      },
      {
        id: 'dishwasher.powerOff',
        method: 'setPower',
        label: t('Power off', 'Spegni'),
        phrase: t('Turn off {device}', 'Spegni {device}'),
        icon: 'power-off',
        args: { on: false },
      },
      {
        id: 'dishwasher.halfLoadOn',
        method: 'setHalfLoad',
        label: t('Half load on', 'Mezzo carico attivo'),
        phrase: t('Turn on half load on {device}', 'Attiva il mezzo carico su {device}'),
        icon: 'contrast',
        args: { on: true },
      },
      {
        id: 'dishwasher.halfLoadOff',
        method: 'setHalfLoad',
        label: t('Half load off', 'Mezzo carico spento'),
        phrase: t('Turn off half load on {device}', 'Disattiva il mezzo carico su {device}'),
        icon: 'contrast',
        args: { on: false },
      },
      {
        id: 'dishwasher.hygienePlusOn',
        method: 'setHygienePlus',
        label: t('Hygiene Plus on', 'Igiene Plus attiva'),
        phrase: t('Turn on Hygiene Plus on {device}', 'Attiva Igiene Plus su {device}'),
        icon: 'sparkles',
        args: { on: true },
      },
      {
        id: 'dishwasher.hygienePlusOff',
        method: 'setHygienePlus',
        label: t('Hygiene Plus off', 'Igiene Plus spenta'),
        phrase: t('Turn off Hygiene Plus on {device}', 'Disattiva Igiene Plus su {device}'),
        icon: 'sparkles',
        args: { on: false },
      },
      {
        id: 'dishwasher.extraDryOn',
        method: 'setExtraDry',
        label: t('Extra dry on', 'Asciugatura extra attiva'),
        phrase: t('Turn on extra dry on {device}', 'Attiva l’asciugatura extra su {device}'),
        icon: 'sun',
        args: { on: true },
      },
      {
        id: 'dishwasher.extraDryOff',
        method: 'setExtraDry',
        label: t('Extra dry off', 'Asciugatura extra spenta'),
        phrase: t('Turn off extra dry on {device}', 'Disattiva l’asciugatura extra su {device}'),
        icon: 'sun',
        args: { on: false },
      },
      {
        id: 'dishwasher.intensiveZoneOn',
        method: 'setIntensiveZone',
        label: t('Intensive zone on', 'Zona intensiva attiva'),
        phrase: t('Turn on the intensive zone on {device}', 'Attiva la zona intensiva su {device}'),
        icon: 'flame',
        args: { on: true },
      },
      {
        id: 'dishwasher.intensiveZoneOff',
        method: 'setIntensiveZone',
        label: t('Intensive zone off', 'Zona intensiva spenta'),
        phrase: t(
          'Turn off the intensive zone on {device}',
          'Disattiva la zona intensiva su {device}',
        ),
        icon: 'flame',
        args: { on: false },
      },
      {
        id: 'dishwasher.varioSpeedOn',
        method: 'setVarioSpeedPlus',
        label: t('Speed boost on', 'Lavaggio rapido attivo'),
        phrase: t('Turn on the speed boost on {device}', 'Attiva il lavaggio rapido su {device}'),
        icon: 'zap',
        args: { on: true },
      },
      {
        id: 'dishwasher.varioSpeedOff',
        method: 'setVarioSpeedPlus',
        label: t('Speed boost off', 'Lavaggio rapido spento'),
        phrase: t(
          'Turn off the speed boost on {device}',
          'Disattiva il lavaggio rapido su {device}',
        ),
        icon: 'zap',
        args: { on: false },
      },
      {
        id: 'dishwasher.childLockOn',
        method: 'setChildLock',
        label: t('Child lock on', 'Blocco bambini attivo'),
        phrase: t('Turn on the child lock of {device}', 'Attiva il blocco bambini di {device}'),
        icon: 'lock',
        args: { on: true },
      },
      {
        id: 'dishwasher.childLockOff',
        method: 'setChildLock',
        label: t('Child lock off', 'Blocco bambini spento'),
        phrase: t('Turn off the child lock of {device}', 'Disattiva il blocco bambini di {device}'),
        icon: 'lock-open',
        args: { on: false },
      },
    ],
    notOperatorFacing: {
      setOption:
        'a raw appliance option key/value; every option worth naming has its own action above',
    },
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('Cycle', 'Ciclo'),
        values: [
          { value: 'idle', label: t('Idle', 'Inattiva') },
          {
            value: 'running',
            label: t('Running', 'In funzione'),
            phrase: t('When {device} starts a cycle', 'Quando {device} inizia un lavaggio'),
          },
          { value: 'paused', label: t('Paused', 'In pausa') },
          {
            value: 'finished',
            label: t('Finished', 'Terminato'),
            phrase: t('When {device} finishes', 'Quando {device} finisce il lavaggio'),
          },
          {
            value: 'error',
            label: t('Error', 'Errore'),
            phrase: t('When {device} reports an error', 'Quando {device} segnala un errore'),
          },
          { value: 'unavailable', label: t('Unavailable', 'Non disponibile') },
        ],
        icon: 'washing-machine',
      },
      {
        kind: 'numeric',
        field: 'progressPercent',
        quantity: t('the cycle progress', 'l’avanzamento del lavaggio'),
        label: t('Progress', 'Avanzamento'),
        unit: '%',
        icon: 'loader',
      },
      {
        kind: 'boolean',
        field: 'doorOpen',
        label: t('Door open', 'Sportello aperto'),
        whenTrue: t('When the door of {device} opens', 'Quando si apre lo sportello di {device}'),
        whenFalse: t(
          'When the door of {device} closes',
          'Quando si chiude lo sportello di {device}',
        ),
        icon: 'door-open',
      },
      {
        kind: 'boolean',
        field: 'filterCleaningDue',
        label: t('Filter cleaning due', 'Pulizia filtro da fare'),
        whenTrue: t(
          'When {device} asks for its filter to be cleaned',
          'Quando {device} chiede di pulire il filtro',
        ),
        whenFalse: t(
          'When the filter reminder of {device} clears',
          'Quando l’avviso filtro di {device} rientra',
        ),
        icon: 'funnel',
      },
      {
        kind: 'boolean',
        field: 'machineCareDue',
        label: t('Machine care due', 'Manutenzione da fare'),
        whenTrue: t(
          'When {device} asks for a machine-care cycle',
          'Quando {device} chiede un ciclo di manutenzione',
        ),
        whenFalse: t(
          'When the machine-care reminder of {device} clears',
          'Quando l’avviso di manutenzione di {device} rientra',
        ),
        icon: 'wrench',
      },
    ],
  },

  'pet-feeder': {
    scope: 'device',
    noun: t('Pet feeder', 'Distributore di cibo'),
    actions: [
      {
        id: 'petFeeder.feed',
        method: 'feed',
        label: t('Feed', 'Dai da mangiare'),
        phrase: t('Dispense {grams} from {device}', 'Eroga {grams} da {device}'),
        icon: 'paw-print',
        openArgs: [
          {
            key: 'grams',
            label: t('Grams', 'Grammi'),
            offer: { kind: 'number', min: 4, max: 200, step: 1, unit: 'g' },
            optional: true,
          },
        ],
      },
      {
        id: 'petFeeder.feedHoppers',
        method: 'feed',
        label: t('Feed from both hoppers', 'Eroga da entrambi i serbatoi'),
        phrase: t(
          'Dispense {hopper1} and {hopper2} from {device}',
          'Eroga {hopper1} e {hopper2} da {device}',
        ),
        icon: 'paw-print',
        openArgs: [
          {
            key: 'hopper1',
            label: t('Hopper 1', 'Serbatoio 1'),
            offer: { kind: 'number', min: 4, max: 200, step: 1, unit: 'g' },
            optional: true,
          },
          {
            key: 'hopper2',
            label: t('Hopper 2', 'Serbatoio 2'),
            offer: { kind: 'number', min: 4, max: 200, step: 1, unit: 'g' },
            optional: true,
          },
        ],
      },
      {
        id: 'petFeeder.cancelFeed',
        method: 'cancelFeed',
        label: t('Cancel feeding', 'Annulla l’erogazione'),
        phrase: t('Cancel the feeding on {device}', 'Annulla l’erogazione di {device}'),
        icon: 'circle-x',
      },
      {
        id: 'petFeeder.callPet',
        method: 'callPet',
        label: t('Call pet', 'Chiama l’animale'),
        phrase: t('Call your pet with {device}', 'Chiama l’animale con {device}'),
        icon: 'megaphone',
      },
      {
        id: 'petFeeder.playSound',
        method: 'playSound',
        label: t('Play sound', 'Riproduci un suono'),
        phrase: t('Play sound {soundId} on {device}', 'Riproduci il suono {soundId} su {device}'),
        icon: 'volume-2',
        openArgs: [
          {
            key: 'soundId',
            label: t('Sound', 'Suono'),
            offer: { kind: 'number', min: 0, step: 1 },
          },
        ],
      },
      {
        id: 'petFeeder.resetDesiccant',
        method: 'resetDesiccant',
        label: t('Desiccant replaced', 'Essiccante sostituito'),
        phrase: t(
          'Mark the desiccant of {device} as replaced',
          'Segna come sostituito l’essiccante di {device}',
        ),
        icon: 'refresh-cw',
      },
      {
        id: 'petFeeder.foodReplenished',
        method: 'markFoodReplenished',
        label: t('Food refilled', 'Cibo ricaricato'),
        phrase: t('Mark {device} as refilled', 'Segna {device} come ricaricato'),
        icon: 'package',
      },
      {
        id: 'petFeeder.childLockOn',
        method: 'setChildLock',
        label: t('Child lock on', 'Blocco bambini attivo'),
        phrase: t('Turn on the child lock of {device}', 'Attiva il blocco bambini di {device}'),
        icon: 'lock',
        args: { on: true },
      },
      {
        id: 'petFeeder.childLockOff',
        method: 'setChildLock',
        label: t('Child lock off', 'Blocco bambini spento'),
        phrase: t('Turn off the child lock of {device}', 'Disattiva il blocco bambini di {device}'),
        icon: 'lock-open',
        args: { on: false },
      },
      {
        id: 'petFeeder.lightOn',
        method: 'setIndicatorLight',
        label: t('Indicator light on', 'Spia accesa'),
        phrase: t('Turn on the indicator light of {device}', 'Accendi la spia di {device}'),
        icon: 'lightbulb',
        args: { on: true },
      },
      {
        id: 'petFeeder.lightOff',
        method: 'setIndicatorLight',
        label: t('Indicator light off', 'Spia spenta'),
        phrase: t('Turn off the indicator light of {device}', 'Spegni la spia di {device}'),
        icon: 'lightbulb-off',
        args: { on: false },
      },
      {
        id: 'petFeeder.feedSoundOn',
        method: 'setFeedSound',
        label: t('Feeding sound on', 'Suono di erogazione attivo'),
        phrase: t(
          'Turn on the feeding sound of {device}',
          'Attiva il suono di erogazione di {device}',
        ),
        icon: 'volume-2',
        args: { on: true },
      },
      {
        id: 'petFeeder.feedSoundOff',
        method: 'setFeedSound',
        label: t('Feeding sound off', 'Suono di erogazione spento'),
        phrase: t(
          'Turn off the feeding sound of {device}',
          'Disattiva il suono di erogazione di {device}',
        ),
        icon: 'volume-x',
        args: { on: false },
      },
      {
        id: 'petFeeder.volume',
        method: 'setVolume',
        label: t('Set volume', 'Imposta il volume'),
        phrase: t(
          'Set the volume of {device} to {level}',
          'Imposta il volume di {device} a {level}',
        ),
        icon: 'volume-2',
        openArgs: [
          {
            key: 'level',
            label: t('Volume', 'Volume'),
            offer: { kind: 'number', min: 0, step: 1 },
          },
        ],
      },
    ],
    state: [
      {
        kind: 'boolean',
        field: 'lowFood',
        label: t('Food low', 'Cibo in esaurimento'),
        whenTrue: t('When {device} runs low on food', 'Quando il cibo di {device} sta finendo'),
        whenFalse: t(
          'When {device} has enough food again',
          'Quando {device} ha di nuovo cibo a sufficienza',
        ),
        icon: 'package',
      },
      {
        kind: 'boolean',
        field: 'feeding',
        label: t('Feeding', 'In erogazione'),
        whenTrue: t('When {device} starts feeding', 'Quando {device} inizia a erogare'),
        whenFalse: t('When {device} finishes feeding', 'Quando {device} finisce di erogare'),
        icon: 'paw-print',
      },
      {
        kind: 'numeric',
        field: 'desiccantLeftDays',
        quantity: t('the desiccant life', 'la durata dell’essiccante'),
        label: t('Desiccant', 'Essiccante'),
        unit: 'd',
        icon: 'calendar-clock',
      },
    ],
  },

  'media-player': {
    scope: 'device',
    noun: t('Media player', 'Lettore multimediale'),
    actions: [
      {
        id: 'media.play',
        method: 'play',
        label: t('Play', 'Riproduci'),
        phrase: t('Play on {device}', 'Avvia la riproduzione su {device}'),
        icon: 'play',
      },
      {
        id: 'media.pause',
        method: 'pause',
        label: t('Pause media', 'Metti in pausa'),
        phrase: t('Pause {device}', 'Metti in pausa {device}'),
        icon: 'pause',
      },
      {
        id: 'media.stop',
        method: 'stop',
        label: t('Stop media', 'Ferma la riproduzione'),
        phrase: t('Stop {device}', 'Ferma {device}'),
        icon: 'square',
      },
      {
        id: 'media.next',
        method: 'next',
        label: t('Next track', 'Brano successivo'),
        phrase: t('Skip to the next track on {device}', 'Passa al brano successivo su {device}'),
        icon: 'skip-forward',
      },
      {
        id: 'media.previous',
        method: 'previous',
        label: t('Previous track', 'Brano precedente'),
        phrase: t(
          'Go back to the previous track on {device}',
          'Torna al brano precedente su {device}',
        ),
        icon: 'skip-back',
      },
      {
        id: 'media.volume',
        method: 'setVolume',
        label: t('Set volume', 'Imposta il volume'),
        phrase: t(
          'Set the volume of {device} to {volumeLevel}',
          'Imposta il volume di {device} al {volumeLevel}',
        ),
        icon: 'volume-2',
        openArgs: [
          {
            key: 'volumeLevel',
            label: t('Volume', 'Volume'),
            offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
          },
        ],
      },
      {
        id: 'media.mute',
        method: 'setMute',
        label: t('Mute', 'Silenzia'),
        phrase: t('Mute {device}', 'Silenzia {device}'),
        icon: 'volume-x',
        args: { muted: true },
      },
      {
        id: 'media.unmute',
        method: 'setMute',
        label: t('Unmute', 'Riattiva l’audio'),
        phrase: t('Unmute {device}', 'Riattiva l’audio di {device}'),
        icon: 'volume-2',
        args: { muted: false },
      },
      {
        id: 'media.shuffleOn',
        method: 'setShuffle',
        label: t('Shuffle on', 'Riproduzione casuale attiva'),
        phrase: t('Turn on shuffle on {device}', 'Attiva la riproduzione casuale su {device}'),
        icon: 'shuffle',
        args: { shuffle: true },
      },
      {
        id: 'media.shuffleOff',
        method: 'setShuffle',
        label: t('Shuffle off', 'Riproduzione casuale spenta'),
        phrase: t('Turn off shuffle on {device}', 'Disattiva la riproduzione casuale su {device}'),
        icon: 'shuffle',
        args: { shuffle: false },
      },
      {
        id: 'media.repeat',
        method: 'setRepeat',
        label: t('Set repeat', 'Imposta la ripetizione'),
        phrase: t(
          'Set repeat on {device} to {repeat}',
          'Imposta la ripetizione di {device} su {repeat}',
        ),
        icon: 'repeat',
        openArgs: [
          {
            key: 'repeat',
            label: t('Repeat', 'Ripetizione'),
            offer: {
              kind: 'enum',
              values: [
                { value: 'off', label: t('Off', 'Disattivata') },
                { value: 'all', label: t('All', 'Tutti i brani') },
                { value: 'one', label: t('One track', 'Un brano') },
              ],
            },
          },
        ],
      },
      {
        id: 'media.source',
        method: 'selectSource',
        label: t('Select source', 'Scegli la sorgente'),
        phrase: t('Switch {device} to {source}', 'Passa {device} alla sorgente {source}'),
        icon: 'cast',
        openArgs: [
          {
            key: 'source',
            label: t('Source', 'Sorgente'),
            offer: {
              kind: 'dynamic',
              from: 'status',
              field: 'availableSources',
            },
          },
        ],
      },
      {
        id: 'media.seek',
        method: 'seek',
        label: t('Seek', 'Vai al punto'),
        phrase: t('Move {device} to {positionMs}', 'Porta {device} al punto {positionMs}'),
        icon: 'fast-forward',
        openArgs: [
          {
            key: 'positionMs',
            label: t('Position', 'Posizione'),
            offer: { kind: 'number', min: 0, step: 1000, unit: 'ms' },
          },
        ],
      },
      {
        id: 'media.playMedia',
        method: 'playMedia',
        label: t('Play media', 'Riproduci un contenuto'),
        phrase: t('Play {mediaId} on {device}', 'Riproduci {mediaId} su {device}'),
        icon: 'music',
        openArgs: [
          {
            key: 'mediaId',
            label: t('Media', 'Contenuto'),
            offer: { kind: 'text' },
          },
          {
            key: 'mediaType',
            label: t('Media type', 'Tipo di contenuto'),
            offer: { kind: 'text' },
          },
        ],
      },
    ],
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('Playback', 'Riproduzione'),
        values: [
          {
            value: 'off',
            label: t('Off', 'Spento'),
            phrase: t('When {device} turns off', 'Quando {device} si spegne'),
          },
          {
            value: 'on',
            label: t('On', 'Acceso'),
            phrase: t('When {device} turns on', 'Quando {device} si accende'),
          },
          { value: 'idle', label: t('Idle', 'Inattivo') },
          {
            value: 'playing',
            label: t('Playing', 'In riproduzione'),
            phrase: t('When {device} starts playing', 'Quando {device} inizia a riprodurre'),
          },
          {
            value: 'paused',
            label: t('Paused', 'In pausa'),
            phrase: t('When {device} is paused', 'Quando {device} va in pausa'),
          },
          { value: 'buffering', label: t('Buffering', 'In caricamento') },
          { value: 'standby', label: t('Standby', 'In standby') },
        ],
        icon: 'music',
      },
      {
        kind: 'numeric',
        field: 'volumeLevel',
        quantity: t('the volume', 'il volume'),
        label: t('Volume', 'Volume'),
        unit: '%',
        icon: 'volume-2',
      },
      {
        kind: 'boolean',
        field: 'isMuted',
        label: t('Muted', 'Silenziato'),
        whenTrue: t('When {device} is muted', 'Quando {device} viene silenziato'),
        whenFalse: t('When {device} is unmuted', 'Quando l’audio di {device} torna attivo'),
        icon: 'volume-x',
      },
      {
        kind: 'value',
        field: 'source',
        label: t('Source', 'Sorgente'),
        offer: { kind: 'dynamic', from: 'status', field: 'availableSources' },
        icon: 'cast',
      },
    ],
  },

  consumables: {
    scope: 'device',
    noun: t('Consumables', 'Materiali di consumo'),
    actions: [
      {
        id: 'consumables.reset',
        method: 'reset',
        label: t('Mark as replaced', 'Segna come sostituito'),
        phrase: t('Mark {key} as replaced on {device}', 'Segna {key} come sostituito su {device}'),
        icon: 'refresh-cw',
        openArgs: [
          {
            key: 'key',
            label: t('Consumable', 'Materiale'),
            offer: {
              kind: 'dynamic',
              from: 'status',
              field: 'items',
              valueKey: 'key',
              labelKey: 'label',
              where: { key: 'resettable', equals: true },
            },
          },
        ],
      },
    ],
  },

  navigation: {
    scope: 'device',
    noun: t('Robot movement', 'Movimento del robot'),
    actions: [
      {
        id: 'navigation.stop',
        method: 'stop',
        label: t('Stop', 'Ferma'),
        phrase: t('Stop {device}', 'Ferma {device}'),
        icon: 'square',
      },
      {
        id: 'navigation.runAction',
        method: 'runAction',
        label: t('Run a routine', 'Esegui una routine'),
        phrase: t('Have {device} {actionId}', 'Fai eseguire a {device}: {actionId}'),
        icon: 'bot',
        openArgs: [
          {
            key: 'actionId',
            label: t('Routine', 'Routine'),
            offer: {
              kind: 'enum',
              values: [
                { value: 'goHome', label: t('go home', 'torna alla base') },
                {
                  value: 'locate',
                  label: t('beep so you can find it', 'suona per farsi trovare'),
                },
                {
                  value: 'spotClean',
                  label: t('clean this spot', 'pulisci questo punto'),
                },
                {
                  value: 'findPet',
                  label: t('find the pet', 'cerca l’animale'),
                },
                {
                  value: 'personFollow',
                  label: t('follow a person', 'segui una persona'),
                },
                { value: 'stop', label: t('stop', 'fermati') },
                {
                  value: 'startClean',
                  label: t('start cleaning', 'inizia a pulire'),
                },
                {
                  value: 'pauseClean',
                  label: t('pause cleaning', 'metti in pausa la pulizia'),
                },
                {
                  value: 'dockWash',
                  label: t('wash the mop at the dock', 'lava il mocio alla base'),
                },
                {
                  value: 'autoEmpty',
                  label: t('empty the bin at the dock', 'svuota il contenitore alla base'),
                },
                {
                  value: 'flashOn',
                  label: t('turn the flash on', 'accendi il flash'),
                },
                {
                  value: 'flashOff',
                  label: t('turn the flash off', 'spegni il flash'),
                },
              ],
            },
          },
        ],
      },
      {
        id: 'navigation.playSound',
        method: 'playSound',
        label: t('Play sound', 'Riproduci un suono'),
        phrase: t('Play {soundId} on {device}', 'Riproduci {soundId} su {device}'),
        icon: 'volume-2',
        openArgs: [
          {
            key: 'soundId',
            label: t('Sound', 'Suono'),
            offer: {
              kind: 'dynamic',
              from: 'method',
              method: 'listActions',
              valueKey: 'soundId',
              labelKey: 'label',
              where: { key: 'kind', equals: 'sound' },
              valueKind: 'number',
            },
          },
        ],
      },
      {
        id: 'navigation.lightOn',
        method: 'setLightOn',
        label: t('Light on', 'Luce accesa'),
        phrase: t('Turn on the light of {device}', 'Accendi la luce di {device}'),
        icon: 'lightbulb',
        args: { on: true },
      },
      {
        id: 'navigation.lightOff',
        method: 'setLightOn',
        label: t('Light off', 'Luce spenta'),
        phrase: t('Turn off the light of {device}', 'Spegni la luce di {device}'),
        icon: 'lightbulb-off',
        args: { on: false },
      },
      {
        id: 'navigation.lightAuto',
        method: 'setLightMode',
        label: t('Light automatic', 'Luce automatica'),
        phrase: t(
          'Set the light of {device} to automatic',
          'Metti la luce di {device} in automatico',
        ),
        icon: 'lightbulb',
        args: { mode: 'auto' },
      },
      {
        id: 'navigation.lightLevel',
        method: 'setLightLevel',
        label: t('Set light level', 'Imposta la luce'),
        phrase: t('Set the light of {device} to {level}', 'Imposta la luce di {device} al {level}'),
        icon: 'sun-medium',
        openArgs: [
          {
            key: 'level',
            label: t('Level', 'Livello'),
            offer: { kind: 'number', min: 40, max: 100, step: 1, unit: '%' },
          },
        ],
      },
    ],
    notOperatorFacing: {
      move: 'joystick control from the live view — continuous, not a discrete step',
      goToPoint: 'tap-to-go on the live map — the point only means something on that picture',
    },
    state: [
      {
        kind: 'enum',
        field: 'mode',
        label: t('Activity', 'Attività'),
        values: [
          { value: 'idle', label: t('Idle', 'Inattivo') },
          { value: 'cleaning', label: t('Cleaning', 'In pulizia') },
          { value: 'spot', label: t('Spot cleaning', 'Pulizia localizzata') },
          { value: 'following', label: t('Following', 'In inseguimento') },
          {
            value: 'goto',
            label: t('Moving to a point', 'In movimento verso un punto'),
          },
          { value: 'returning', label: t('Returning', 'In rientro') },
          { value: 'paused', label: t('Paused', 'In pausa') },
          { value: 'unknown', label: t('Unknown', 'Sconosciuto') },
        ],
        icon: 'bot',
      },
    ],
    events: {
      onStatusChanged: {
        notOperatorFacing: 'the `mode` state trigger reads the same change',
      },
    },
  },

  'script-runner': {
    scope: 'device',
    noun: t('Script', 'Script'),
    actions: [
      {
        id: 'script.run',
        method: 'run',
        label: t('Run script', 'Esegui lo script'),
        phrase: t('Run {device}', 'Esegui {device}'),
        icon: 'scroll-text',
      },
      {
        id: 'script.stop',
        method: 'stop',
        label: t('Stop script', 'Ferma lo script'),
        phrase: t('Stop {device}', 'Ferma {device}'),
        icon: 'square',
      },
    ],
    state: [
      {
        kind: 'boolean',
        field: 'isRunning',
        label: t('Running', 'In esecuzione'),
        whenTrue: t('When {device} starts running', 'Quando {device} parte'),
        whenFalse: t('When {device} finishes', 'Quando {device} termina'),
        icon: 'scroll-text',
      },
    ],
  },

  'automation-control': {
    scope: 'device',
    noun: t('Automation', 'Automazione'),
    actions: [
      {
        id: 'haAutomation.enable',
        method: 'enable',
        label: t('Enable automation', 'Abilita l’automazione'),
        phrase: t('Enable {device}', 'Abilita {device}'),
        icon: 'toggle-right',
      },
      {
        id: 'haAutomation.disable',
        method: 'disable',
        label: t('Disable automation', 'Disabilita l’automazione'),
        phrase: t('Disable {device}', 'Disabilita {device}'),
        icon: 'toggle-left',
      },
      {
        id: 'haAutomation.trigger',
        method: 'trigger',
        label: t('Trigger automation', 'Avvia l’automazione'),
        phrase: t('Run {device} now', 'Esegui subito {device}'),
        icon: 'workflow',
      },
    ],
    state: [
      {
        kind: 'boolean',
        field: 'enabled',
        label: t('Enabled', 'Abilitata'),
        whenTrue: t('When {device} is enabled', 'Quando {device} viene abilitata'),
        whenFalse: t('When {device} is disabled', 'Quando {device} viene disabilitata'),
        icon: 'toggle-right',
      },
      {
        kind: 'boolean',
        field: 'isRunning',
        label: t('Running', 'In esecuzione'),
        whenTrue: t('When {device} starts running', 'Quando {device} parte'),
        whenFalse: t('When {device} finishes', 'Quando {device} termina'),
        icon: 'workflow',
      },
    ],
  },

  notifier: {
    scope: 'device',
    noun: t('Notifier', 'Notificatore'),
    actions: [
      {
        id: 'notifier.send',
        method: 'send',
        label: t('Send a notification', 'Invia una notifica'),
        phrase: t('Send “{body}” through {device}', 'Invia «{body}» tramite {device}'),
        icon: 'send',
        openArgs: [
          {
            key: 'title',
            label: t('Title', 'Titolo'),
            offer: { kind: 'text' },
            optional: true,
          },
          {
            key: 'body',
            label: t('Message', 'Messaggio'),
            offer: { kind: 'text' },
          },
          {
            key: 'priority',
            label: t('Priority', 'Priorità'),
            offer: {
              kind: 'enum',
              values: [
                { value: 'min', label: t('Minimal', 'Minima') },
                { value: 'low', label: t('Low', 'Bassa') },
                { value: 'normal', label: t('Normal', 'Normale') },
                { value: 'high', label: t('High', 'Alta') },
              ],
            },
            optional: true,
          },
        ],
      },
    ],
    events: {
      onSent: {
        notOperatorFacing:
          'a delivery receipt of a send this system made — not a fact about the world',
      },
    },
  },

  'running-state': {
    scope: 'device',
    noun: t('Running', 'In funzione'),
    state: [
      {
        kind: 'boolean',
        field: 'running',
        label: t('Running', 'In funzione'),
        whenTrue: t('When {device} starts', 'Quando {device} inizia'),
        whenFalse: t('When {device} finishes', 'Quando {device} finisce'),
        icon: 'play',
      },
    ],
    events: {
      onStarted: {
        category: EventCategory.RunningStarted,
        label: t('Started running', 'Ha iniziato a funzionare'),
        phrase: t('When {device} starts running', 'Quando {device} inizia a funzionare'),
        icon: 'play',
      },
      onFinished: {
        category: EventCategory.RunningFinished,
        label: t('Finished', 'Ha finito'),
        phrase: t('When {device} finishes', 'Quando {device} finisce'),
        icon: 'square',
      },
    },
  },

  update: {
    scope: 'device',
    noun: t('Firmware update', 'Aggiornamento firmware'),
    actions: [
      {
        id: 'update.install',
        method: 'installUpdate',
        label: t('Install update', 'Installa l’aggiornamento'),
        phrase: t(
          'Install the available update on {device}',
          'Installa l’aggiornamento disponibile su {device}',
        ),
        icon: 'download',
      },
    ],
    state: [
      {
        kind: 'boolean',
        field: 'updatable',
        label: t('Update available', 'Aggiornamento disponibile'),
        whenTrue: t(
          'When an update is available for {device}',
          'Quando è disponibile un aggiornamento per {device}',
        ),
        whenFalse: t('When {device} is up to date', 'Quando {device} è aggiornato'),
        icon: 'download',
      },
      {
        kind: 'boolean',
        field: 'inProgress',
        label: t('Updating', 'In aggiornamento'),
        whenTrue: t('When {device} starts updating', 'Quando {device} inizia ad aggiornarsi'),
        whenFalse: t('When {device} finishes updating', 'Quando {device} finisce di aggiornarsi'),
        icon: 'loader',
      },
    ],
  },
}
