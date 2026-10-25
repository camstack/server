export type { ExportAlexaActions } from './custom-actions.js'
// Kernel discovers customActions on the module object without instantiating
// the addon. Re-export under the conventional name so addon-loader picks it up.
export { exportAlexaActions, exportAlexaActions as customActions } from './custom-actions.js'
// `AlexaRtcEgress` is GONE. It was an `RtpEgress`-shaped wrapper that was
// exported and NEVER instantiated: its own docblock said it existed "so the
// typechecker can keep us honest as the shared-transcode refactor lands" and
// that "none of the bytes flow through this object today". The refactor has now
// landed and it kept nobody honest — a leftover that describes the right design
// reads as verification of it.
export {
  ALEXA_EGRESS_PROFILE,
  acquireAlexaEgress,
  releaseAlexaEgress,
} from './egress/alexa-rtc-egress.js'
export { default, ExportAlexaAddon } from './export-alexa.addon.js'
