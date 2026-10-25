// Re-expose the inner default so kernel addon-loader picks it via mod.default.
export { default as DecoderNodeAvAddon, default } from './addon/index.js'
// node-av audio codec (audio-codec cap) — this addon owns both caps.
export { NodeAvAudioCodecProvider } from './audio-codec/provider.js'
export {
  loadNodeAvRuntime,
  peekNodeAvRuntime,
  type NodeAvRuntime,
} from './audio-codec/nodeav-runtime-loader.js'
export {
  NodeAvAudioDecodeSession,
  type NodeAvAudioDecodeConfig,
} from './audio-codec/nodeav-audio-decode-session.js'
export {
  NodeAvAudioEncodeSession,
  type NodeAvAudioEncodeConfig,
} from './audio-codec/nodeav-audio-encode-session.js'
