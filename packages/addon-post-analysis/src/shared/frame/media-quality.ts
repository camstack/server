/**
 * Shared JPEG quality for all persisted pipeline-analytics media (event crops,
 * track snapshots, key frames). Kept high — these blobs ARE the operator's
 * evidence and are stored at native (or near-native) resolution, so the encode
 * quality must not be the bottleneck. Single source of truth so the dispatcher
 * and the key-frame path never drift apart.
 */
export const MEDIA_QUALITY = 88
