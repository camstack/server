/**
 * Every number tracker v2 decides with (D683), with where it came from. None
 * is a setting: a camera that needs its own value is shown by a case first
 * (spec §7). Changing one requires a reconstructed scene or a D681 case that
 * moves.
 */

// ── L1 ────────────────────────────────────────────────────────────────────
/**
 * A prediction never extrapolates further than this past the last association
 * (D399's 1 s ceiling). The same bound demotes a tracklet unseen for longer to
 * `coasting` before association (task-6 review H1): past it the prediction is
 * not trusted, so the tracklet gets the last-box gate and the size bar, as it
 * would had a frame recorded the miss. With the motion gate stopping frames
 * (D438) no frame did, and a newcomer on the stale prediction took the id.
 */
export const MAX_PREDICTION_MS = 1000
/**
 * A frame more than `maxMissedMs` behind the latest is a CLOCK STEP only as
 * the K-th such frame in a row, each in order with the one before (follow-up
 * 102, fix round 3; D49: a read that would destroy work needs another to
 * agree). A step ends every track on the camera; one stray timestamp — a
 * backlog spike 4.5 s late — or two runner clocks delivering interleaved
 * (a camera migrating between runners) must not. Three is the least that a
 * single late frame plus an interleaved partner cannot reach by chance; the
 * cost of a real step is K−1 dropped frames (~260 ms at 7.7 fps).
 */
export const CLOCK_STEP_CONFIRM_FRAMES = 3
/** Confident boxes kept on a tracklet's path (the old tracker's bound). */
export const MAX_PATH_LENGTH = 300
/** Swap test: crossed pairs cheaper than this over the chosen pairs are doubt. */
export const SWAP_MARGIN = 0.2
/** Rival / competitor test: a second box, or a second tracklet, this close in cost is doubt. */
export const RIVAL_MARGIN = 0.1
/** Weight of the appearance distance in the L1 cost (only when appearance is calibrated). */
export const APPEARANCE_COST_WEIGHT = 0.5
/** Appearance resolves an ambiguity only when the chosen pairing wins by this much. */
export const APPEARANCE_SEPARATES = 0.15
/** D678's size bar, applied to a COASTING re-bind as it is to a link (review M12). */
export const COAST_MAX_AREA_RATIO = 2.5
/**
 * A split piece's doubt is bounded (review H9): after this long it is confirmed
 * and emitted even if its subjects still overlap — an alert is never lost to
 * doubt. It keeps `contestedHits`, so L2 still links it on appearance only.
 */
export const CONTESTED_MAX_MS = 3000

// ── Faces (review C3, review 2 NH1) ─────────────────────────────────────────
/**
 * How long L2 waits for the FaceRecognizer's verdict on a face-bearing piece,
 * from that piece's FIRST face. A face-bearing box is any box with a face
 * detail inside it — no pixel floor: the recognizer's 48 px floor is native
 * pixels, and a detection-frame face on this hub is 16.5–28.2 px
 * (`face-size-score.ts`), so a detection-frame floor would make nothing
 * face-bearing. The verdict settles at p50 11.4 s after first sight (spec
 * §4.4); this is the operator's cap (20 s) until Task 23 measures the p90 of
 * `identity.t − first face frame t` on the committed tapes and lowers it —
 * never above 20 s.
 */
export const FACE_SETTLE_HOLD_MS = 20_000

// ── L2 ────────────────────────────────────────────────────────────────────
/**
 * How long both layers keep an ended piece (`prune`: `endedAt + LINK_WINDOW_MS`).
 *
 * Invariant (task-8 review M3): every arc is DECIDED before either end is
 * pruned. The latest decision, from the predecessor's last sighting, is
 *   `LINK_MAX_GAP_MS` (the successor starts)
 *   + `LINK_DECIDE_MAX_MS` + `LINK_DECIDE_MARGIN_MS` (its first face comes just
 *     before the faceless refusal)
 *   + `FACE_SETTLE_HOLD_MS` + `LINK_DECIDE_MARGIN_MS` (the recognition wait, then its refusal)
 *   + one close-sweep period (a silent camera steps only every 5 s),
 * = 10 + 15 + 25 + 5 = 55 s today. A predecessor pruned before that is gone,
 * and its successor is decided `new / no-candidate` with no error. Raising any
 * term eats the 5 s of headroom: `__tests__/constants.spec.ts` asserts it.
 */
export const LINK_WINDOW_MS = 60_000
/** Longest gap an arc may bridge, from the predecessor's last sighting (D665's graveyard band). */
export const LINK_MAX_GAP_MS = 10_000
/** Evidence the later piece needs before its arc may commit. */
export const LINK_EVIDENCE_MS = 3_000
/** An arc still undecided this long after the later piece started (and after its latest candidate's gap) is refused. */
export const LINK_DECIDE_MAX_MS = 10_000
/** Slack past that deadline, so a sparse step (the 5 s sweep) never refuses a ready arc (review H1). */
export const LINK_DECIDE_MARGIN_MS = 5_000
export const LINK_MAX_COST = 1.0
export const LINK_AMBIGUITY_MARGIN = 0.15
export const LINK_MAX_AREA_RATIO = 2.5
export const LINK_REACH_DIAGONALS_PER_SEC = 0.25
export const LINK_REACH_MIN_DIAGONALS = 0.75
export const LINK_REACH_MAX_DIAGONALS = 2.0
export const LINK_VEHICLE_REACH_DIAGONALS = 0.75
export const LINK_APPEARANCE_REJECT = 0.6
export const LINK_NO_APPEARANCE_COST = 0.25
export const LINK_WEIGHT_GAP = 0.35
export const LINK_WEIGHT_REACH = 0.35
export const LINK_WEIGHT_SIZE = 0.3

/** Classes whose sub-floor boxes may follow a MOVING tracklet (D665). A
 *  vehicle's sub-floor box follows nothing: a parked car is the registry's,
 *  and a sub-floor box on it must never carry a passing car (D410's hop). */
export const LINGERING_CLASSES: ReadonlySet<string> = new Set(['person', 'animal'])

// ── Appearance ────────────────────────────────────────────────────────────
/**
 * Below this, a block's Bhattacharyya `diff` is float noise from the block's
 * sqrt/divide chain, not signal: an identical pair must read exactly 0, and an
 * unguarded sqrt() amplifies a ~1e-16 residual (machine epsilon accumulated
 * over the block) into a ~1e-8 "distance" — measured directly on a 32-bin Hs
 * block, a diff of 5.5e-16 read back as 2.36e-8 once square-rooted.
 */
export const APPEARANCE_DIFF_EPSILON = 1e-9
