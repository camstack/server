export { default as MotionWasmAddon } from './addon/index.js'
// Re-expose the inner default so kernel addon-loader picks it via mod.default.
export { default } from './addon/index.js'
export {
  WasmMotionDetector,
  type WasmMotionConfig,
  type WasmMotionRegion,
} from './wasm-motion-detector.js'
