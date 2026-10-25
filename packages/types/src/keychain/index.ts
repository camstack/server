export {
  clearKnownSecrets,
  forgetKnownSecret,
  knownSecretCount,
  MIN_SCRUBBED_LENGTH,
  registerKnownSecret,
  scrubKnownSecrets,
  shortSecretRefHash,
} from './known-secrets.js'
export {
  classifySecretWrite,
  isSecretClear,
  isSecretFieldView,
  isSecretMarker,
  isSecretMarkerLike,
  makeSecretMarker,
  SECRET_CLEAR,
  type SecretClearInstruction,
  type SecretFieldView,
  type SecretMarker,
  type SecretWriteIntent,
  toSecretFieldView,
} from './secret-marker.js'
export {
  arrayItemFieldPath,
  buildSecretRef,
  formatSecretScope,
  globalSecretScope,
  isSecretRef,
  normalizeSecretOwner,
  parseSecretRef,
  SECRET_REF_SCHEME,
  type SecretRefParts,
  type SecretScope,
} from './secret-ref.js'
export {
  createSecretsAccess,
  type KeychainTransport,
  REVALIDATE_AFTER_MS,
  type SecretsAccess,
  type SecretsAccessOptions,
} from './secrets-access.js'
export { resolveSecretViewsIn } from './resolve-secret-views.js'
