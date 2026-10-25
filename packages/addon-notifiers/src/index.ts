export type {
  HttpRequestBody,
  HttpRequestPlan,
  HttpResponseLike,
  JsonRequestBody,
  MultipartPart,
  MultipartRequestBody,
  NotifierAdapter,
  RawRequestBody,
  TargetConfig,
  TextRequestBody,
} from './adapters/adapter.js'
export { default, NotifiersAddon } from './addon.js'
// The hub's forked-addon harvest imports the ENTRY module and reads the
// `customActions` NAMED export (see addon-registry loadForkedCustomActionCatalog).
export { ncTargetActions as customActions } from './nc-target-actions.js'
export type { FetchedAttachment } from './http.js'
export {
  makeNcTargetHandlers,
  ncTargetActions,
  type NcTargetActionDeps,
  type NcTargetActionHandlers,
  type NcTargetActions,
  type NcTargetProvider,
} from './nc-target-actions.js'
export {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_OUTPUT_TIMEOUT_MS,
  fetchAttachmentBytes,
  fetchWithTimeout,
  sendHttpPlan,
} from './http.js'
export type {
  AttachmentFetcher,
  HttpSender,
  NotificationOutputProviderDeps,
} from './provider.js'
export { createNotificationOutputProvider, NOTIFIERS_ADDON_ID } from './provider.js'
export { mergeSecrets, passwordFieldKeys, REDACTED_MARKER, redactForRead } from './secrets.js'
export { TARGETS_COLLECTION, TargetStore } from './target-store.js'
