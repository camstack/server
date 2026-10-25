/**
 * Recorder addon defaults shared between the addon shell and its specs.
 *
 * Default segment length. 10s (raised from 4s — R3): ~3x fewer files per
 * hour/profile (360 vs 900), which cuts inode/directory-metadata writes and
 * eviction unlink storms — the main small-file disk-wear driver (F2). Still
 * keyframe-cut passthrough (`-c:v copy` cuts on the nearest source GOP
 * boundary). The tradeoff — coarser keyframe-scrub preview granularity — is
 * offset by the scrub engine's sub-segment decode-forward (R8). Per-device
 * `RecordingConfig.segmentSeconds` still overrides this.
 */
export const DEFAULT_SEGMENT_SECONDS = 10
