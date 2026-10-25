/**
 * `debug.gt.*` — the admin fallback for ground-truth marks (D681, spec §4.3).
 * SAME body and SAME store as the four cap methods; they exist so labelling
 * can start with one `camstack deploy`, before a server train carries the cap
 * methods to the hub. Not a second rule set.
 */
import {
  ClearTrackRelationInputSchema,
  ClearTrackRelationResultSchema,
  customAction,
  defineCustomActions,
  ListTrackRelationsInputSchema,
  ListTrackRelationsResultSchema,
  SetTrackPurityInputSchema,
  SetTrackPurityResultSchema,
  SetTrackRelationInputSchema,
  TrackRelationSchema,
} from '@camstack/types'

export const gtActions = defineCustomActions({
  'debug.gt.setRelation': customAction(SetTrackRelationInputSchema, TrackRelationSchema, {
    auth: 'admin',
  }),
  'debug.gt.clearRelation': customAction(
    ClearTrackRelationInputSchema,
    ClearTrackRelationResultSchema,
    { auth: 'admin' },
  ),
  'debug.gt.setPurity': customAction(SetTrackPurityInputSchema, SetTrackPurityResultSchema, {
    auth: 'admin',
  }),
  'debug.gt.list': customAction(ListTrackRelationsInputSchema, ListTrackRelationsResultSchema, {
    auth: 'admin',
  }),
})

export type GtActions = typeof gtActions
