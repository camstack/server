/**
 * The subject path — the ONE geometry of a track's path over a frame (D903).
 *
 * The implementation lives in `@camstack/types` (`geometry/subject-path.ts`)
 * because the hub's notification picture draws the same line and a server
 * addon cannot take this React bundle. Re-exported here so a UI surface finds
 * it beside the rest of the library; it adds nothing and copies nothing.
 */
export {
  buildSubjectPath,
  isDrawableSubjectPath,
  projectSubjectPath,
  SUBJECT_PATH_DWELL_EPS,
  SUBJECT_PATH_FULL_FRAME_COVERAGE,
  SUBJECT_PATH_MAX_POINTS,
  type SubjectPath,
  type SubjectPathNode,
  type SubjectPathOptions,
  type SubjectPathPoint,
  type SubjectPathRect,
  type SubjectPathSample,
  subjectPathSampleFromBox,
  subjectPathSvgPoints,
} from '@camstack/types'
