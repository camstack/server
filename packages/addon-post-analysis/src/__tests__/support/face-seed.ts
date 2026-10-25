import type { FaceRecord } from '../../pipeline-analytics/store/face-store.js'

/** Settings-store seed row: face buffer fields plus legacy inline embedding JSON. */
export type TestFaceSeedData = Omit<FaceRecord, 'id'>

export function testFaceSeedData(overrides: Partial<TestFaceSeedData> = {}): TestFaceSeedData {
  return {
    deviceId: 1,
    trackId: 'trk-1',
    timestamp: 1000,
    embedding: [0.1, 0.2],
    assigned: false,
    ...overrides,
  }
}

/** Fake settings-store row for {@link FACES_COLLECTION} seeding in specs. */
export function testFaceSeedRow(
  id: string,
  overrides: Partial<TestFaceSeedData> = {},
): { id: string; data: Record<string, unknown> } {
  const face = testFaceSeedData(overrides)
  const data: Record<string, unknown> = {
    deviceId: face.deviceId,
    trackId: face.trackId,
    timestamp: face.timestamp,
    embedding: [...face.embedding],
    assigned: face.assigned,
  }
  if (face.recognizedIdentityId !== undefined) {
    data.recognizedIdentityId = face.recognizedIdentityId
  }
  if (face.mediaId !== undefined) data.mediaId = face.mediaId
  return { id, data }
}
