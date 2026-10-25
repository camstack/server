/**
 * Co-compiled Edge TPU sets — pool-level artifacts, not models (D724).
 *
 * A Coral holds ~6.9 MiB of parameter cache. Two separately compiled models
 * carry two different cache tokens, so every alternation between them on one
 * Coral flushes the cache and re-streams the incoming model's parameters over
 * USB (D710). `edgetpu_compiler` given several models at once allocates the
 * cache between them, in command-line order, under ONE token: loaded from the
 * same set, they never evict each other — whatever does not fit is streamed on
 * every invoke of THAT model instead.
 *
 * Each member is the SAME model as its catalog entry's `formats.tflite` (same
 * `modelId`, same int8 graph, same labels and licence record), compiled
 * together with the other members (D710: a Coral build is a format of the
 * survivor; the set is where it is placed, not a new model). A Coral pool picks
 * at most one set from the models placed on it (`coral-cocompiled-set.ts`) and
 * falls back to the separately compiled `formats.tflite` for everything else.
 *
 * Built by `scripts/build-edgetpu-sets.py` (compile order = `members` order =
 * cache priority) and hosted under `edgetpuSets/<id>/`. Only sets whose
 * measured cost is acceptable are listed here: a set that would make the root
 * detector stream parameters on every frame (root + YuNet at 640: the root
 * keeps 3.34 of its 6.39 MiB, YuNet's activations take the rest) is
 * deliberately absent.
 */
import { hfModelUrl } from '@camstack/types'

const HF_REPO = 'camstack/camstack-models'
const setFile = (setId: string, file: string): string =>
  hfModelUrl(HF_REPO, `edgetpuSets/${setId}/${setId}__${file}`)

/** One model of a set: which catalog build it stands for, and its set-compiled file. */
export interface CoCompiledSetMember {
  readonly stepId: string
  readonly modelId: string
  readonly url: string
  readonly sizeMB: number
  /** Measured by the compiler for this set: parameters kept on chip / re-streamed per invoke. */
  readonly onChipMiB: number
  readonly streamedMiB: number
}

export interface CoCompiledSet {
  readonly id: string
  /** The set reserves the cache for the root detector first — eligible only on a pool that runs it. */
  readonly hostsRoot: boolean
  /** Compile order = cache priority. */
  readonly members: readonly CoCompiledSetMember[]
}

const SSD = 'ssd-mobilenet-v2-coco-edgetpu'
const YUNET = 'yunet-2023mar'
const YOLOX = 'yolox-tiny-plate'
const BIRD = 'bird-classifier'

export const EDGETPU_COCOMPILED_SETS: readonly CoCompiledSet[] = [
  {
    // One Coral: the root keeps its whole cache; plate detection (<= 8 per
    // track) and the bird classifier (<= 3 per track) stream theirs.
    id: 'root-plate-bird',
    hostsRoot: true,
    members: [
      {
        stepId: 'object-detection',
        modelId: SSD,
        url: setFile('root-plate-bird', 'ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite'),
        sizeMB: 6.9,
        onChipMiB: 6.39,
        streamedMiB: 0,
      },
      {
        stepId: 'plate-detection',
        modelId: YOLOX,
        url: setFile('root-plate-bird', 'camstack-yolox-tiny-plate_int8_edgetpu.tflite'),
        sizeMB: 6.9,
        onChipMiB: 0.08,
        streamedMiB: 5.41,
      },
      {
        stepId: 'bird-classifier',
        modelId: BIRD,
        url: setFile('root-plate-bird', 'mobilenet_v2_1.0_224_inat_bird_quant_edgetpu.tflite'),
        sizeMB: 4.9,
        onChipMiB: 0,
        streamedMiB: 4.54,
      },
    ],
  },
  {
    // A Coral that does not run the root (a second Coral, steps jumped onto
    // it): YuNet fully cached, the rest shares what its 640 activations leave.
    id: 'face-plate-bird',
    hostsRoot: false,
    members: [
      {
        stepId: 'face-detection',
        modelId: YUNET,
        url: setFile('face-plate-bird', 'camstack-yunet-2023mar_int8_edgetpu.tflite'),
        sizeMB: 0.7,
        onChipMiB: 0.11,
        streamedMiB: 0,
      },
      {
        stepId: 'plate-detection',
        modelId: YOLOX,
        url: setFile('face-plate-bird', 'camstack-yolox-tiny-plate_int8_edgetpu.tflite'),
        sizeMB: 6.9,
        onChipMiB: 3.23,
        streamedMiB: 2.27,
      },
      {
        stepId: 'bird-classifier',
        modelId: BIRD,
        url: setFile('face-plate-bird', 'mobilenet_v2_1.0_224_inat_bird_quant_edgetpu.tflite'),
        sizeMB: 4.9,
        onChipMiB: 0,
        streamedMiB: 4.54,
      },
    ],
  },
  {
    // The same second Coral without faces: plate fully cached.
    id: 'plate-bird',
    hostsRoot: false,
    members: [
      {
        stepId: 'plate-detection',
        modelId: YOLOX,
        url: setFile('plate-bird', 'camstack-yolox-tiny-plate_int8_edgetpu.tflite'),
        sizeMB: 6.9,
        onChipMiB: 5.55,
        streamedMiB: 0,
      },
      {
        stepId: 'bird-classifier',
        modelId: BIRD,
        url: setFile('plate-bird', 'mobilenet_v2_1.0_224_inat_bird_quant_edgetpu.tflite'),
        sizeMB: 4.1,
        onChipMiB: 0.92,
        streamedMiB: 2.8,
      },
    ],
  },
]
