/**
 * Detection classes — shared between CamStack app and proxy.
 * Aligned with the shared detection-class taxonomy.
 */

// ---------------------------------------------------------------------------
// Enum — matches the plugin enum exactly
// ---------------------------------------------------------------------------

export enum DetectionClass {
  Motion = 'motion',
  Person = 'person',
  Vehicle = 'vehicle',
  Animal = 'animal',
  Audio = 'audio',
  Face = 'face',
  Plate = 'plate',
  Package = 'package',
  Doorbell = 'doorbell',
  Sensor = 'sensor',
}

// ---------------------------------------------------------------------------
// Sub-class arrays (for classname → parent mapping)
// ---------------------------------------------------------------------------

export const animalClasses: readonly string[] = [
  DetectionClass.Animal,
  'dog_cat',
  'dog',
  'cat',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe',
  'mouse',
  'rabbit',
  'deer',
  'lion',
  'tiger',
  'bird',
  'eagle',
  'owl',
  'pigeon',
  'fish',
  'whale',
  'dolphin',
  'snake',
  'turtle',
  'lizard',
]

export const personClasses: readonly string[] = [
  DetectionClass.Person,
  'people',
  'pedestrian',
  'rider',
  'driver',
  'cyclist',
  'skier',
  'skateboarder',
  'face',
  'hand',
  'head',
  'body',
]

export const vehicleClasses: readonly string[] = [
  DetectionClass.Vehicle,
  'car',
  'truck',
  'bus',
  'motorcycle',
  'bicycle',
  'van',
  'ambulance',
  'police_car',
  'fire_truck',
  'train',
  'subway',
  'tram',
  'airplane',
  'boat',
  'ship',
  'helicopter',
]

export const faceClasses: readonly string[] = [
  DetectionClass.Face,
  'eyes',
  'nose',
  'mouth',
  'ears',
  'eyebrows',
  'left_eye',
  'right_eye',
  'pupil',
  'iris',
  'eyelid',
  'eye_corner',
  'upper_lip',
  'lower_lip',
  'teeth',
  'chin',
  'cheek',
  'forehead',
  'jaw',
  'glasses',
  'sunglasses',
  'facial_hair',
  'beard',
  'mustache',
  'facial_landmark',
  'facial_keypoint',
]

export const licensePlateClasses: readonly string[] = [
  DetectionClass.Plate,
  'license_plate',
  'front_plate',
  'rear_plate',
  'motorcycle_plate',
  'temporary_plate',
  'dealer_plate',
  'licensePlate',
  'plate_number',
  'plate_character',
  'plate_digit',
  'plate_letter',
  'plate_symbol',
  'plate_region',
  'plate_country_identifier',
  'plate_frame',
  'plate_bolt',
  'plate_sticker',
  'plate_validation_tag',
  'damaged_plate',
  'obscured_plate',
  'dirty_plate',
]

export const motionClasses: readonly string[] = [DetectionClass.Motion, 'movement', 'other']

export const packageClasses: readonly string[] = [DetectionClass.Package, 'packet']

export const audioClasses: readonly string[] = [DetectionClass.Audio]

/** Common YAMNet audio labels (advanced-notifier). Parent: Audio. */
export const audioLabelClasses: readonly string[] = [
  'speech',
  'scream',
  'babbling',
  'yell',
  'bellow',
  'whoop',
  'whispering',
  'laughter',
  'snicker',
  'crying',
  'cry',
  'sigh',
  'singing',
  'choir',
  'chant',
  'mantra',
  'child_singing',
  'rapping',
  'humming',
  'groan',
  'grunt',
  'whistling',
  'breathing',
  'wheeze',
  'snoring',
  'gasp',
  'pant',
  'snort',
  'cough',
  'throat_clearing',
  'sneeze',
  'sniff',
  'cheering',
  'applause',
  'chatter',
  'crowd',
  'children_playing',
  'bark',
  'yip',
  'howl',
  'bow-wow',
  'growling',
  'whimper_dog',
  'purr',
  'meow',
  'hiss',
  'caterwaul',
  'pets',
  'livestock',
  'doorbell',
  'ding-dong',
  'door',
  'slam',
  'knock',
  'alarm',
  'telephone',
  'music',
  'dog',
  'dogs',
]

export const doorbellClasses: readonly string[] = [DetectionClass.Doorbell, 'ring']

/** Sensor types (advanced-notifier SupportedSensorType). Parent: Sensor. */
export const sensorLabelClasses: readonly string[] = [
  'lock',
  'binary',
  'flood',
  'entry',
  'door',
  'leak',
  'door_open',
  'flooded',
  'entry_open',
]

function listIncludes(list: readonly string[], value: string): boolean {
  return list.includes(value)
}

// ---------------------------------------------------------------------------
// Classname → parent DetectionClass map
// ---------------------------------------------------------------------------

export const detectionClassesDefaultMap: Record<string, DetectionClass> = {
  ...animalClasses.reduce<Record<string, DetectionClass>>(
    (tot, curr) => ({ ...tot, [curr]: DetectionClass.Animal }),
    {},
  ),
  ...personClasses.reduce<Record<string, DetectionClass>>(
    (tot, curr) => ({ ...tot, [curr]: DetectionClass.Person }),
    {},
  ),
  ...vehicleClasses.reduce<Record<string, DetectionClass>>(
    (tot, curr) => ({ ...tot, [curr]: DetectionClass.Vehicle }),
    {},
  ),
  ...motionClasses.reduce<Record<string, DetectionClass>>(
    (tot, curr) => ({ ...tot, [curr]: DetectionClass.Motion }),
    {},
  ),
  ...packageClasses.reduce<Record<string, DetectionClass>>(
    (tot, curr) => ({ ...tot, [curr]: DetectionClass.Package }),
    {},
  ),
  ...faceClasses.reduce<Record<string, DetectionClass>>(
    (tot, curr) => ({ ...tot, [curr]: DetectionClass.Face }),
    {},
  ),
  ...licensePlateClasses.reduce<Record<string, DetectionClass>>(
    (tot, curr) => ({ ...tot, [curr]: DetectionClass.Plate }),
    {},
  ),
  ...audioClasses.reduce<Record<string, DetectionClass>>(
    (tot, curr) => ({ ...tot, [curr]: DetectionClass.Audio }),
    {},
  ),
  ...audioLabelClasses.reduce<Record<string, DetectionClass>>(
    (tot, curr) => ({ ...tot, [curr]: DetectionClass.Audio }),
    {},
  ),
  ...doorbellClasses.reduce<Record<string, DetectionClass>>(
    (tot, curr) => ({ ...tot, [curr]: DetectionClass.Doorbell }),
    {},
  ),
  ...sensorLabelClasses.reduce<Record<string, DetectionClass>>(
    (tot, curr) => ({ ...tot, [curr]: DetectionClass.Sensor }),
    {},
  ),
}

// ---------------------------------------------------------------------------
// Classifier helpers
// ---------------------------------------------------------------------------

export const isFaceClassname = (c: string): boolean => listIncludes(faceClasses, c)
export const isPlateClassname = (c: string): boolean => listIncludes(licensePlateClasses, c)
export const isAnimalClassname = (c: string): boolean => listIncludes(animalClasses, c)
export const isPersonClassname = (c: string): boolean => listIncludes(personClasses, c)
export const isVehicleClassname = (c: string): boolean => listIncludes(vehicleClasses, c)
export const isMotionClassname = (c: string): boolean => listIncludes(motionClasses, c)
export const isDoorbellClassname = (c: string): boolean => listIncludes(doorbellClasses, c)
export const isPackageClassname = (c: string): boolean => listIncludes(packageClasses, c)
export const isAudioClassname = (c: string): boolean =>
  listIncludes(audioClasses, c) || listIncludes(audioLabelClasses, c)
export const isSensorLabelClassname = (c: string): boolean => listIncludes(sensorLabelClasses, c)
export const isLabelDetection = (c: string): boolean => isFaceClassname(c) || isPlateClassname(c)

export const getParentClass = (className: string): DetectionClass | undefined =>
  detectionClassesDefaultMap[className]

export const getParentDetectionClass = (det: {
  label?: string
  className: string
}): DetectionClass | undefined => {
  const { className } = det
  const baseMap: Record<string, DetectionClass> = {
    [DetectionClass.Face]: DetectionClass.Person,
    [DetectionClass.Plate]: DetectionClass.Vehicle,
  }
  const parentGroup = detectionClassesDefaultMap[className]
  if (parentGroup && parentGroup !== className) return parentGroup
  return baseMap[className]
}

// ---------------------------------------------------------------------------
// All detection classes (enum values) used in filter UI
// ---------------------------------------------------------------------------

export const defaultDetectionClasses: DetectionClass[] = Object.values(DetectionClass)

/** Default enabled classes: all except Motion. */
export const DEFAULT_ENABLED_CLASSES: DetectionClass[] = defaultDetectionClasses.filter(
  (c) => c !== DetectionClass.Motion,
)

// ---------------------------------------------------------------------------
// Timeline event presets (by severity)
// ---------------------------------------------------------------------------

export type TimelineEventPreset = 'all' | 'important' | 'critical' | 'custom'

/** Classes for "critical" preset: security-relevant only (person, doorbell, package). */
export const TIMELINE_PRESET_CRITICAL: string[] = [
  DetectionClass.Person,
  DetectionClass.Doorbell,
  DetectionClass.Package,
]

/** Classes for "important" preset: critical + vehicle, animal, audio, face, plate. */
export const TIMELINE_PRESET_IMPORTANT: string[] = [
  ...TIMELINE_PRESET_CRITICAL,
  DetectionClass.Vehicle,
  DetectionClass.Animal,
  DetectionClass.Audio,
  DetectionClass.Face,
  DetectionClass.Plate,
]

/** Classes for "all" preset: same as DEFAULT_ENABLED_CLASSES. */
export const TIMELINE_PRESET_ALL: string[] = [...DEFAULT_ENABLED_CLASSES]

/** Get enabled classes for a preset. For "custom", pass customClasses. */
export function getClassesForTimelinePreset(
  preset: TimelineEventPreset,
  customClasses?: string[],
): string[] {
  switch (preset) {
    case 'critical':
      return TIMELINE_PRESET_CRITICAL
    case 'important':
      return TIMELINE_PRESET_IMPORTANT
    case 'all':
      return TIMELINE_PRESET_ALL
    case 'custom':
      return customClasses?.length ? customClasses : DEFAULT_ENABLED_CLASSES
    default:
      return DEFAULT_ENABLED_CLASSES
  }
}
