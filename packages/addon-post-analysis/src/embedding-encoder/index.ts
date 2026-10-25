export { default as EmbeddingEncoderAddon } from './addon/index.js'
// Re-expose the inner default so kernel addon-loader picks it via mod.default.
export { default } from './addon/index.js'
export type { IEmbeddingEncoder, EmbeddingResult, EmbeddingInfo } from '@camstack/types'
