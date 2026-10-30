/**
 * The slices of hub payloads the ops tools read now live in `@camstack/develop`
 * (shared with `camstack mcp`); this module only re-exports them so the
 * operator MCP keeps one import site.
 */
export {
  CameraStatusSchema,
  LogDestinationProviderSchema,
  MediaInfoSchema,
  MediaWithBytesSchema,
  RecentTracksPageSchema,
  TrackSchema,
  parseWire,
  type LogDestinationProvider,
  type MediaInfo,
  type MediaWithBytes,
  type RecentTracksPage,
  type Track,
  type TrackBBox,
  type TrackEnvelope,
  type TrackPosition,
} from '@camstack/develop'
