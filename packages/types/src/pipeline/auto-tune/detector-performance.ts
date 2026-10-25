/**
 * Measured YOLOv9 detector latency per hardware class × accelerator, and the
 * person accuracy each model reaches at its shipped floor — the data the Best
 * settings recommender picks from (D745).
 *
 * Transcribed from `docs/benchmarks/detector-latency.json` (latency) and
 * `docs/benchmarks/model-floors.json` (person precision / recall at the
 * shipped floor). `__tests__/detector-performance.spec.ts` holds both tables
 * equal to those files, so a re-measurement replaces the JSON and this file
 * together. Only the YOLOv9 t/s/m family is here (plus, in each `coral` column,
 * the one Edge TPU build a Coral runs by default, `yolov9s-320-edgetpu`, D912): the cluster runs ONE family
 * (YOLOv9 — the one that runs well on every accelerator class measured), and
 * tier c is not offered (a few recall points for 25–50 % more latency).
 */
import type { AcceleratorKind, HardwareClassId } from './plan-schemas.js'

/** One measured (or derived) latency cell. */
export interface DetectorLatencyCell {
  /** Single-request median latency. */
  readonly p50Ms: number
  /** Throughput ceiling of one accelerator running only this model. */
  readonly fps: number
  /** False for a cell derived from another column (scaled), not measured. */
  readonly measured: boolean
  /**
   * Set when this cell was scaled from another class's measured column (D930).
   * Absent on a measured cell and on a cell derived inside the same column.
   */
  readonly estimatedFrom?: HardwareClassId
}

/** `modelId → cell` for one (hardware class, accelerator) column. */
export type DetectorLatencyColumn = Readonly<Record<string, DetectorLatencyCell>>

/** The latency table: hardware class → accelerator → column. */
export type DetectorPerfTable = Readonly<
  Partial<
    Record<HardwareClassId, Readonly<Partial<Record<AcceleratorKind, DetectorLatencyColumn>>>>
  >
>

/** Person precision / recall of one model at its shipped person floor. */
export interface DetectorAccuracy {
  readonly personPrecision: number
  readonly personRecall: number
}

export const DETECTOR_PERF: DetectorPerfTable = {
  'intel-core-ultra': {
    'intel-npu': {
      'yolov9t-320': { p50Ms: 2.9, fps: 383, measured: true },
      'yolov9t-320-int8': { p50Ms: 3.8, fps: 333, measured: true },
      'yolov9t-640': { p50Ms: 7.4, fps: 139, measured: true },
      'yolov9t-640-int8': { p50Ms: 7.5, fps: 144, measured: true },
      'yolov9s-320': { p50Ms: 4.4, fps: 241, measured: true },
      'yolov9s-320-int8': { p50Ms: 4.1, fps: 264, measured: true },
      'yolov9s-640': { p50Ms: 12.7, fps: 82, measured: true },
      'yolov9s-640-int8': { p50Ms: 10.7, fps: 99, measured: true },
      'yolov9m-320': { p50Ms: 8.4, fps: 123, measured: true },
      'yolov9m-320-int8': { p50Ms: 6.5, fps: 165, measured: true },
      'yolov9m-640': { p50Ms: 29.5, fps: 32, measured: true },
      'yolov9m-640-int8': { p50Ms: 19.5, fps: 52, measured: true },
    },
    'intel-igpu': {
      'yolov9t-320': { p50Ms: 2.6, fps: 405, measured: true },
      'yolov9t-320-int8': { p50Ms: 2.8, fps: 324, measured: true },
      'yolov9t-640': { p50Ms: 6.5, fps: 157, measured: true },
      'yolov9t-640-int8': { p50Ms: 5.6, fps: 185, measured: true },
      'yolov9s-320': { p50Ms: 4.6, fps: 200, measured: true },
      'yolov9s-320-int8': { p50Ms: 4.1, fps: 239, measured: true },
      'yolov9s-640': { p50Ms: 15.2, fps: 69, measured: true },
      'yolov9s-640-int8': { p50Ms: 10.5, fps: 99, measured: true },
      'yolov9m-320': { p50Ms: 11.4, fps: 88, measured: true },
      'yolov9m-320-int8': { p50Ms: 7.0, fps: 127, measured: true },
      'yolov9m-640': { p50Ms: 40.0, fps: 25, measured: true },
      'yolov9m-640-int8': { p50Ms: 23.5, fps: 44, measured: true },
    },
    'x86-cpu': {
      'yolov9t-320': { p50Ms: 6.9, fps: 145, measured: true },
      'yolov9t-320-int8': { p50Ms: 2.7, fps: 405, measured: true },
      'yolov9t-640': { p50Ms: 23.0, fps: 44, measured: true },
      'yolov9t-640-int8': { p50Ms: 8.8, fps: 124, measured: true },
      'yolov9s-320': { p50Ms: 15.8, fps: 63, measured: true },
      'yolov9s-320-int8': { p50Ms: 6.5, fps: 180, measured: true },
      'yolov9s-640': { p50Ms: 58.2, fps: 17, measured: true },
      'yolov9s-640-int8': { p50Ms: 20.1, fps: 52, measured: true },
      'yolov9m-320': { p50Ms: 40.0, fps: 25, measured: true },
      'yolov9m-320-int8': { p50Ms: 14.2, fps: 74, measured: true },
      'yolov9m-640': { p50Ms: 155.8, fps: 6, measured: true },
      'yolov9m-640-int8': { p50Ms: 52.4, fps: 19, measured: true },
    },
    coral: { 'yolov9s-320-edgetpu': { p50Ms: 32, fps: 31, measured: false } },
  },
  'intel-n-series': {
    'intel-igpu': {
      'yolov9t-320': { p50Ms: 15.0, fps: 48, measured: true },
      'yolov9t-320-int8': { p50Ms: 14.1, fps: 67, measured: true },
      'yolov9t-640': { p50Ms: 38.5, fps: 26, measured: true },
      'yolov9t-640-int8': { p50Ms: 50, fps: 20, measured: true },
      'yolov9s-320': { p50Ms: 41.4, fps: 24, measured: true },
      'yolov9s-320-int8': { p50Ms: 23.3, fps: 34, measured: true },
      'yolov9s-640': { p50Ms: 127.4, fps: 8, measured: true },
      'yolov9s-640-int8': { p50Ms: 81, fps: 12, measured: true },
      'yolov9m-320': { p50Ms: 63.5, fps: 16, measured: true },
      'yolov9m-320-int8': { p50Ms: 66, fps: 15, measured: true },
      'yolov9m-640': { p50Ms: 215.5, fps: 5, measured: true },
      'yolov9m-640-int8': { p50Ms: 163, fps: 6, measured: true },
    },
    'x86-cpu': {
      'yolov9t-320': { p50Ms: 86.2, fps: 12, measured: true },
      'yolov9t-320-int8': { p50Ms: 52.7, fps: 20, measured: true },
      'yolov9t-640': { p50Ms: 322.1, fps: 3, measured: true },
      'yolov9t-640-int8': { p50Ms: 205.6, fps: 5, measured: true },
      'yolov9s-320': { p50Ms: 164.4, fps: 6, measured: true },
      'yolov9s-320-int8': { p50Ms: 86.9, fps: 12, measured: true },
      'yolov9s-640': { p50Ms: 341.3, fps: 3, measured: true },
      'yolov9s-640-int8': { p50Ms: 185.3, fps: 5, measured: true },
      'yolov9m-320': { p50Ms: 166.8, fps: 6, measured: true },
      'yolov9m-320-int8': { p50Ms: 226.3, fps: 4, measured: true },
      'yolov9m-640': { p50Ms: 663.5, fps: 2, measured: true },
      'yolov9m-640-int8': { p50Ms: 324.4, fps: 3, measured: true },
    },
    coral: { 'yolov9s-320-edgetpu': { p50Ms: 32, fps: 31, measured: false } },
  },
  'amd-phoenix': {
    // agent-b (2026-10-10): plain = onnx:cpu, -int8 = openvino:cpu.
    'x86-cpu': {
      'yolov9t-320': { p50Ms: 24, fps: 42, measured: true },
      'yolov9t-320-int8': { p50Ms: 12, fps: 83, measured: true },
      'yolov9t-640': { p50Ms: 50, fps: 20, measured: true },
      'yolov9t-640-int8': { p50Ms: 20, fps: 50, measured: true },
      'yolov9s-320': { p50Ms: 30, fps: 33, measured: true },
      'yolov9s-320-int8': { p50Ms: 15, fps: 67, measured: true },
      'yolov9s-640': { p50Ms: 92, fps: 11, measured: true },
      'yolov9s-640-int8': { p50Ms: 27, fps: 37, measured: true },
      'yolov9m-320': { p50Ms: 67, fps: 15, measured: true },
      'yolov9m-320-int8': { p50Ms: 21, fps: 48, measured: true },
      'yolov9m-640': { p50Ms: 229, fps: 4, measured: true },
      'yolov9m-640-int8': { p50Ms: 48, fps: 21, measured: true },
    },
    // agent-b onnx:webgpu (D823, D845 render node fixed), warm median of
    // 3 (2026-10-23), pool step overhead included. See detector-latency.json.
    'amd-igpu': {
      'yolov9t-320': { p50Ms: 40, fps: 25, measured: true },
      'yolov9t-640': { p50Ms: 89, fps: 11, measured: true },
      'yolov9s-320': { p50Ms: 65, fps: 15, measured: true },
      'yolov9s-640': { p50Ms: 125, fps: 8, measured: true },
      'yolov9m-320': { p50Ms: 85, fps: 12, measured: true },
      'yolov9m-640': { p50Ms: 228, fps: 4, measured: true },
    },
    coral: { 'yolov9s-320-edgetpu': { p50Ms: 32, fps: 31, measured: true } },
  },
  'apple-m-pro': {
    'apple-ane': {
      'yolov9t-320': { p50Ms: 1.1, fps: 952, measured: true },
      'yolov9t-640': { p50Ms: 3.0, fps: 333, measured: true },
      'yolov9s-320': { p50Ms: 1.5, fps: 667, measured: true },
      'yolov9s-640': { p50Ms: 5.1, fps: 196, measured: true },
      'yolov9m-320': { p50Ms: 3.2, fps: 312, measured: true },
      'yolov9m-640': { p50Ms: 10.2, fps: 98, measured: true },
    },
    coral: { 'yolov9s-320-edgetpu': { p50Ms: 32, fps: 31, measured: false } },
  },
  'apple-m-base': {
    'apple-ane': {
      'yolov9t-320': { p50Ms: 1.32, fps: 758, measured: false },
      'yolov9t-640': { p50Ms: 3.45, fps: 290, measured: true },
      'yolov9s-320': { p50Ms: 1.8, fps: 556, measured: false },
      'yolov9s-640': { p50Ms: 5.46, fps: 183, measured: true },
      'yolov9m-320': { p50Ms: 3.79, fps: 264, measured: true },
      'yolov9m-640': { p50Ms: 10.34, fps: 97, measured: true },
    },
    coral: { 'yolov9s-320-edgetpu': { p50Ms: 32, fps: 31, measured: false } },
  },
}

export const DETECTOR_ACCURACY: Readonly<Record<string, DetectorAccuracy>> = {
  'yolov9m-320': { personPrecision: 0.979, personRecall: 0.649 },
  'yolov9m-320-int8': { personPrecision: 0.974, personRecall: 0.684 },
  'yolov9m-640': { personPrecision: 0.976, personRecall: 0.854 },
  'yolov9m-640-int8': { personPrecision: 0.976, personRecall: 0.847 },
  'yolov9s-320': { personPrecision: 0.958, personRecall: 0.479 },
  'yolov9s-320-int8': { personPrecision: 0.969, personRecall: 0.438 },
  'yolov9s-640': { personPrecision: 0.986, personRecall: 0.753 },
  'yolov9s-640-int8': { personPrecision: 0.963, personRecall: 0.823 },
  'yolov9t-320': { personPrecision: 0.946, personRecall: 0.368 },
  'yolov9t-320-int8': { personPrecision: 0.943, personRecall: 0.347 },
  'yolov9t-640': { personPrecision: 0.979, personRecall: 0.646 },
  'yolov9t-640-int8': { personPrecision: 0.979, personRecall: 0.646 },
}
