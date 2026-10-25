// The legacy device-capabilities tree — a pre-capability-system per-device
// feature model — has been deleted. Only the camera stream utilities that
// still have real consumers (classifyStream, autoAssignProfiles, StreamQuality,
// StreamMetadata, etc.) remain, re-exported from `camera.ts`.
export * from './camera.js'
