/**
 * Audio classification macro classes — maps 521 YAMNet labels into ~25 actionable categories.
 * Same pattern as COCO_TO_MACRO for video detection.
 *
 * Each macro class aggregates related fine-grained labels so the user
 * sees a manageable set of event types in settings, timelines, and notifications.
 */
import type { LabelDefinition, ClassMapDefinition } from '../types/labels.js'

// ---------------------------------------------------------------------------
// Macro class definitions
// ---------------------------------------------------------------------------

// No `icon` here. The glyph for a class is an `iconId` (`audio-<id>`, see
// `audioKindId`) that each UI resolves with its own lucide set — `lucide-react`
// in the web admin, `lucide-react-native` in the viewer. These entries used to
// carry an emoji, and it was the only icon vocabulary the settings spoke while
// every other surface drew the shared set.
export const AUDIO_MACRO_LABELS: readonly LabelDefinition[] = [
  { id: 'speech', name: 'Speech' },
  { id: 'scream', name: 'Scream / Shout' },
  { id: 'crying', name: 'Crying / Baby' },
  { id: 'laughter', name: 'Laughter' },
  { id: 'music', name: 'Music' },
  { id: 'dog', name: 'Dog' },
  { id: 'cat', name: 'Cat' },
  { id: 'bird', name: 'Bird' },
  { id: 'animal', name: 'Animal (other)' },
  { id: 'alarm', name: 'Alarm / Siren' },
  { id: 'doorbell', name: 'Doorbell / Knock' },
  { id: 'glass_breaking', name: 'Glass Breaking' },
  { id: 'gunshot', name: 'Gunshot / Explosion' },
  { id: 'vehicle', name: 'Vehicle' },
  { id: 'siren', name: 'Emergency Siren' },
  { id: 'fire', name: 'Fire / Smoke' },
  { id: 'water', name: 'Water' },
  { id: 'wind', name: 'Wind / Weather' },
  { id: 'door', name: 'Door' },
  { id: 'footsteps', name: 'Footsteps' },
  { id: 'crowd', name: 'Crowd / Chatter' },
  { id: 'telephone', name: 'Telephone' },
  { id: 'engine', name: 'Engine / Motor' },
  { id: 'tools', name: 'Tools / Construction' },
  { id: 'silence', name: 'Silence' },
] as const

// ---------------------------------------------------------------------------
// YAMNet label → macro class mapping (by label name, case-insensitive)
// ---------------------------------------------------------------------------

export const YAMNET_TO_MACRO: ClassMapDefinition = {
  mapping: {
    // Speech
    Speech: 'speech',
    'Child speech, kid speaking': 'speech',
    Conversation: 'speech',
    'Narration, monologue': 'speech',
    Babbling: 'speech',
    Whispering: 'speech',
    'Speech synthesizer': 'speech',
    Humming: 'speech',
    Rapping: 'speech',
    Singing: 'speech',
    Choir: 'speech',
    'Child singing': 'speech',

    // Scream / Shout
    Shout: 'scream',
    Bellow: 'scream',
    Yell: 'scream',
    Screaming: 'scream',
    'Children shouting': 'scream',
    Whoop: 'scream',

    // Crying
    'Crying, sobbing': 'crying',
    'Baby cry, infant cry': 'crying',
    Whimper: 'crying',
    'Wail, moan': 'crying',
    Groan: 'crying',

    // Laughter
    Laughter: 'laughter',
    'Baby laughter': 'laughter',
    Giggle: 'laughter',
    Snicker: 'laughter',
    'Belly laugh': 'laughter',
    'Chuckle, chortle': 'laughter',

    // Music
    Music: 'music',
    'Musical instrument': 'music',
    Guitar: 'music',
    Piano: 'music',
    Drum: 'music',
    'Drum kit': 'music',
    'Violin, fiddle': 'music',
    Flute: 'music',
    Saxophone: 'music',
    Trumpet: 'music',
    Synthesizer: 'music',
    'Pop music': 'music',
    'Rock music': 'music',
    'Hip hop music': 'music',
    'Classical music': 'music',
    Jazz: 'music',
    'Electronic music': 'music',
    'Background music': 'music',

    // Dog
    Dog: 'dog',
    Bark: 'dog',
    Yip: 'dog',
    Howl: 'dog',
    'Bow-wow': 'dog',
    Growling: 'dog',
    'Whimper (dog)': 'dog',

    // Cat
    Cat: 'cat',
    Purr: 'cat',
    Meow: 'cat',
    Hiss: 'cat',
    Caterwaul: 'cat',

    // Bird
    Bird: 'bird',
    'Bird vocalization, bird call, bird song': 'bird',
    'Chirp, tweet': 'bird',
    Squawk: 'bird',
    Crow: 'bird',
    Owl: 'bird',
    'Pigeon, dove': 'bird',

    // Animal (other)
    Animal: 'animal',
    'Domestic animals, pets': 'animal',
    'Livestock, farm animals, working animals': 'animal',
    Horse: 'animal',
    'Cattle, bovinae': 'animal',
    Pig: 'animal',
    Sheep: 'animal',
    Goat: 'animal',
    Frog: 'animal',
    Insect: 'animal',
    Cricket: 'animal',

    // Alarm / Siren
    Alarm: 'alarm',
    'Alarm clock': 'alarm',
    'Smoke detector, smoke alarm': 'alarm',
    'Fire alarm': 'alarm',
    Buzzer: 'alarm',
    'Civil defense siren': 'alarm',
    'Car alarm': 'alarm',

    // Emergency Siren
    Siren: 'siren',
    'Police car (siren)': 'siren',
    'Ambulance (siren)': 'siren',
    'Fire engine, fire truck (siren)': 'siren',
    'Emergency vehicle': 'siren',
    Foghorn: 'siren',

    // Doorbell / Knock
    Doorbell: 'doorbell',
    'Ding-dong': 'doorbell',
    Knock: 'doorbell',
    Tap: 'doorbell',

    // Glass Breaking
    Glass: 'glass_breaking',
    Shatter: 'glass_breaking',
    'Chink, clink': 'glass_breaking',

    // Gunshot / Explosion
    'Gunshot, gunfire': 'gunshot',
    'Machine gun': 'gunshot',
    Explosion: 'gunshot',
    Fireworks: 'gunshot',
    Firecracker: 'gunshot',
    'Artillery fire': 'gunshot',
    'Cap gun': 'gunshot',
    Boom: 'gunshot',

    // Vehicle
    Vehicle: 'vehicle',
    Car: 'vehicle',
    Truck: 'vehicle',
    Bus: 'vehicle',
    Motorcycle: 'vehicle',
    'Car passing by': 'vehicle',
    'Vehicle horn, car horn, honking': 'vehicle',
    'Traffic noise, roadway noise': 'vehicle',
    Train: 'vehicle',
    Aircraft: 'vehicle',
    Helicopter: 'vehicle',
    Bicycle: 'vehicle',
    Skateboard: 'vehicle',

    // Fire / Smoke
    Fire: 'fire',
    Crackle: 'fire',

    // Water
    Water: 'water',
    Rain: 'water',
    Raindrop: 'water',
    'Rain on surface': 'water',
    Stream: 'water',
    Waterfall: 'water',
    Ocean: 'water',
    'Waves, surf': 'water',
    'Splash, splatter': 'water',

    // Wind / Weather
    Wind: 'wind',
    Thunderstorm: 'wind',
    Thunder: 'wind',
    'Wind noise (microphone)': 'wind',
    'Rustling leaves': 'wind',

    // Door
    Door: 'door',
    'Sliding door': 'door',
    Slam: 'door',
    'Cupboard open or close': 'door',

    // Footsteps
    'Walk, footsteps': 'footsteps',
    Run: 'footsteps',
    Shuffle: 'footsteps',

    // Crowd
    Crowd: 'crowd',
    Chatter: 'crowd',
    Cheering: 'crowd',
    Applause: 'crowd',
    'Children playing': 'crowd',
    'Hubbub, speech noise, speech babble': 'crowd',

    // Telephone
    Telephone: 'telephone',
    'Telephone bell ringing': 'telephone',
    Ringtone: 'telephone',
    'Telephone dialing, DTMF': 'telephone',
    'Busy signal': 'telephone',

    // Engine / Motor
    Engine: 'engine',
    'Engine starting': 'engine',
    Idling: 'engine',
    'Accelerating, revving, vroom': 'engine',
    'Light engine (high frequency)': 'engine',
    'Medium engine (mid frequency)': 'engine',
    'Heavy engine (low frequency)': 'engine',
    'Lawn mower': 'engine',
    Chainsaw: 'engine',

    // Tools / Construction
    Hammer: 'tools',
    Jackhammer: 'tools',
    Sawing: 'tools',
    'Power tool': 'tools',
    Drill: 'tools',
    Sanding: 'tools',

    // Silence
    Silence: 'silence',
  },
  preserveOriginal: false,
}

// ---------------------------------------------------------------------------
// Apple SoundAnalysis identifier → macro class mapping
// Apple uses snake_case identifiers (e.g. 'dog_bark', 'siren')
// ---------------------------------------------------------------------------

export const APPLE_SA_TO_MACRO: ClassMapDefinition = {
  mapping: {
    speech: 'speech',
    child_speech: 'speech',
    conversation: 'speech',
    whispering: 'speech',
    singing: 'speech',
    humming: 'speech',
    shout: 'scream',
    yell: 'scream',
    screaming: 'scream',
    crying: 'crying',
    baby_crying: 'crying',
    sobbing: 'crying',
    laughter: 'laughter',
    baby_laughter: 'laughter',
    giggling: 'laughter',
    music: 'music',
    guitar: 'music',
    piano: 'music',
    drums: 'music',
    dog_bark: 'dog',
    dog_bow_wow: 'dog',
    dog_growling: 'dog',
    dog_howl: 'dog',
    cat_meow: 'cat',
    cat_purr: 'cat',
    cat_hiss: 'cat',
    bird: 'bird',
    bird_chirp: 'bird',
    bird_squawk: 'bird',
    animal: 'animal',
    horse: 'animal',
    cow_moo: 'animal',
    insect: 'animal',
    alarm: 'alarm',
    smoke_alarm: 'alarm',
    fire_alarm: 'alarm',
    car_alarm: 'alarm',
    siren: 'siren',
    police_siren: 'siren',
    ambulance_siren: 'siren',
    doorbell: 'doorbell',
    door_knock: 'doorbell',
    knocking: 'doorbell',
    glass_breaking: 'glass_breaking',
    glass_shatter: 'glass_breaking',
    gunshot: 'gunshot',
    explosion: 'gunshot',
    fireworks: 'gunshot',
    car: 'vehicle',
    truck: 'vehicle',
    motorcycle: 'vehicle',
    car_horn: 'vehicle',
    vehicle_horn: 'vehicle',
    traffic: 'vehicle',
    fire: 'fire',
    fire_crackle: 'fire',
    water: 'water',
    rain: 'water',
    ocean: 'water',
    splash: 'water',
    wind: 'wind',
    thunder: 'wind',
    thunderstorm: 'wind',
    door: 'door',
    door_slam: 'door',
    sliding_door: 'door',
    footsteps: 'footsteps',
    walking: 'footsteps',
    running: 'footsteps',
    crowd: 'crowd',
    chatter: 'crowd',
    cheering: 'crowd',
    applause: 'crowd',
    telephone_ring: 'telephone',
    ringtone: 'telephone',
    engine: 'engine',
    engine_starting: 'engine',
    lawn_mower: 'engine',
    chainsaw: 'engine',
    hammer: 'tools',
    jackhammer: 'tools',
    drill: 'tools',
    power_tool: 'tools',
    silence: 'silence',
  },
  preserveOriginal: false,
}

// ---------------------------------------------------------------------------
// Unified lookup — merges YAMNet + Apple SA mappings
// ---------------------------------------------------------------------------

const _macroLookup = new Map<string, string>()
for (const [k, v] of Object.entries(YAMNET_TO_MACRO.mapping)) {
  _macroLookup.set(k.toLowerCase(), v)
}
for (const [k, v] of Object.entries(APPLE_SA_TO_MACRO.mapping)) {
  _macroLookup.set(k.toLowerCase(), v)
}

/** Map a raw audio label (YAMNet or Apple SoundAnalysis) to its macro class. Returns null if unmapped. */
export function mapAudioLabelToMacro(label: string): string | null {
  return _macroLookup.get(label.toLowerCase()) ?? null
}

/** Get all macro class IDs */
export function getAudioMacroClassIds(): readonly string[] {
  return AUDIO_MACRO_LABELS.map((l) => l.id)
}
