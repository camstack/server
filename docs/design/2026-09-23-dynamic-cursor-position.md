# Viewer analysis — a cursor that sits lower once the timeline leaves live

> Status: ANALYSIS, nothing implemented. Viewer app (`camstack/` submodule,
> `src/components/camera/theater/`), linear timeline only. Written 2026-09-23
> while another session was removing `clip-follow.ts` and the cursor's clip
> arm; nothing below depends on either, and the clip arm may be gone by the
> time this is built.

> *"vorrei analizzassi la possibilità di rendere la posizione del cursore
> dinamica in timeline continua: quando siamo in live va benissimo la
> posizione corrente ma man mano che ci si allontana deve arrivare a metà
> timeline. La motivazione è che se faccio lo snap su un cluster il cursore va
> giustamente all'inizio del cluster e con la posizione attuale si perde
> visibilità del cluster"* — the operator. [I would like you to analyse the
> possibility of making the cursor position dynamic in the continuous timeline:
> when we are live the current position is fine, but as we move away it must
> reach the middle of the timeline. The reason is that if I snap onto a cluster
> the cursor rightly goes to the start of the cluster, and with the current
> position the cluster loses visibility.]

## Summary

- The complaint is real and it is geometric, not a bug: the card hangs
  **upward** from the instant a snap seeks to, and the cursor line has only
  70 px above it on a phone. At the default density **47 % of the card is
  above the top of the viewport** after a snap; the wide preset loses 56 %,
  the landscape drawer loses 74 %. Tapping any carousel page other than the
  first can put the whole card off-screen.
- Moving the cursor is the right lever. Every offset in the file family is
  spacer-invariant by construction, so a different line position changes
  **where content is drawn and nothing else** — no follow target, no scrub
  mapping, no content height needs a second formula. One stale copy exists
  and should be retired on the way.
- "Dynamic" should mean **two states on a fact the machine already owns**
  (the timeline is on the live edge, or it is not), held still while a scrub
  gesture is in flight — not a continuous function of distance from live. A
  continuous mapping re-lays out every card per scroll frame, decouples the
  finger from the content, needs a ramp length nothing derives, and **creeps
  while paused** (6.8 px/min at the default zoom) because the live edge
  advances on a 1 Hz clock the follow already re-runs on.
- Cost: one pure resolver (~30 lines + spec), a latch in `TheaterTimeline`,
  six prose sites that currently say "fixed tenth", and the stale
  `maxScroll` copy in `use-timeline-scrub.ts`. One visible artefact remains
  — a 280 px content shift at the release of a hand scrub that leaves live —
  and it is inherent to any cursor that moves; an animation can soften it
  later.

## 1. What breaks today, in numbers

### The geometry that produces it

- `event-cluster.ts` — a card's **bottom** edge is on its anchor instant
  (`topPx = epochToOffset(anchorMs) − sizePx`, guarantee "`topPx + heightPx
  === epochToOffset(anchorMs)` — the card's BOTTOM edge is its first
  displayed event, i.e. the track START"). Time runs downward, so the card
  body covers the track's life, which is newer than the start and therefore
  **above** it.
- `TheaterTimeline.tsx` `onClusterTrackSeek` — a tap seeks to
  `event.timestamp` of the visible carousel page; page zero **is**
  `anchorEvent`, so the seek lands exactly on the card's bottom edge.
- The playback follow (`useEffect` on `mode === 'playback'`) then calls
  `scrollListTo(epochToOffset(activeEpoch))`, which puts that instant on the
  cursor line at `indicatorPx = round(viewport × 10 / 100)`.
- So after a snap the card occupies viewport rows `[indicatorPx − sizePx,
  indicatorPx]`, and only `min(sizePx, indicatorPx)` of it is on screen.

### Card sizes (real formulas: `cardWidth = round(body × cardWidthFraction)`, `sizePx = round(cardWidth × 9/16)`)

Presets from `settings-store.ts` (`compact 0.48 / medium 0.6 / wide 0.72`,
gap `2 / 10 / 22 %`). Bodies: a 700 px phone body (the number the
content-height fix was measured on), a Pro Max, and the landscape drawer
(`drawerWidth` caps at 340; its body is short).

| Body | Preset | card px | cursor @10 % | visible | cut above | @50 % fits |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| iPhone 15, 393×700 | compact | 106 | 70 | 70 (66 %) | 36 | yes |
| iPhone 15 | **medium (default)** | **133** | **70** | **70 (53 %)** | **63** | yes |
| iPhone 15 | wide | 159 | 70 | 70 (44 %) | 89 | yes |
| Pro Max, 430×760 | medium | 145 | 76 | 76 (52 %) | 69 | yes |
| Pro Max | wide | 174 | 76 | 76 (44 %) | 98 | yes |
| drawer, 340×300 | medium | 115 | 30 | 30 (26 %) | 85 | yes |
| drawer | wide | 138 | 30 | 30 (22 %) | 108 | yes |

**No preset fits on any body at 10 %.** Every preset fits at 50 % on every
body (the largest card, 174 px, against 350 px of headroom on a phone and
150 px in the drawer). The visible strip is the card's bottom overlay (pills
+ time label) plus ~45 px of picture — enough to know which card it is, not
enough to see the subject.

### It does not self-correct quickly

Playback slides the card down through the line at the zoom's pixel rate
(`pxPerHour = 60 / rowMinutes × 34`). The 63 px cut at the default density
reaches the line after:

| Zoom | px/min | card spans | cut on screen after |
| --- | ---: | ---: | ---: |
| 12h | 1.13 | 117 min | 56 min |
| 6h | 2.27 | 59 min | 28 min |
| 3h | 6.80 | 20 min | 9.3 min |
| **1h (default)** | **17.0** | **7.8 min** | **3.7 min** |
| 30m | 34.0 | 3.9 min | 1.9 min |

At the default zoom the card is not whole until 3.7 min into a track most
tracks have finished by. At 12h it never is in practice.

### Where the line is: the carousel page

A cluster absorbs events **older** than its anchor by up to `sizePx + gapPx`
(146 px at the default density). Tapping page N > 0 seeks to an older
instant, so the card's bottom edge lands that many px **above** the line:

| tapped event older than anchor by | card bottom @10 % | visible @10 % | visible @50 % |
| ---: | ---: | ---: | ---: |
| 0 (page zero) | 70 px | 70 px | 133 px |
| 30 px | 40 px | 40 px | 133 px |
| 70 px | 0 px | **0 px** | 133 px |
| 146 px (absorption limit) | −76 px | 0 px | 133 px |

So the line between "half a card" and "no card" is a tap ≥ 70 px older than
the anchor: 4 min at the default zoom, 62 min at 12h. At 50 % every case in
the table is whole.

## 2. What "dynamic" should mean

Three candidates, judged on the questions the brief asks.

### (a) Continuous in distance from live — rejected

Whether the distance is time, pixels or the scroll offset, the cursor's
percentage becomes a function of state that changes **while the operator is
reading or dragging**:

- **The finger decouples from the content.** Screen-y of any content is
  `spacer + contentPx − offsetY`. If `spacer = f(offsetY)` grows at rate k,
  the content moves at `(1 − k)×` finger speed. RN's native scroll knows
  nothing of this: the ScrollView keeps the offset, JS re-lays-out the spacer
  under it. A pixel ramp over one viewport is `k = 0.4`.
- **Every card re-renders per scroll frame.** `ClusterSlot` takes
  `top = cluster.topPx + indicatorOffsetPx` — a changing spacer changes every
  mounted card's prop at `scrollEventThrottle={16}`, which is precisely the
  60 Hz storm `scrollOffsetRef` was introduced to remove (`TheaterTimeline`
  comment "that storm is what made scrubbing seize").
- **A pixel ramp moves the cursor when the operator zooms** (same instant,
  different offset); a time ramp moves it differently at every zoom (at 12h
  the whole ramp is 68 px of axis, at 30m it is 2040 px). Neither ramp length
  is derivable from anything in the code.
- **It drifts while nothing is touched** — see §5.

### (b) Two states, switched by what the timeline IS on — recommended

`indicatorPct = LIVE_PCT (10)` while the timeline is on the live edge, else
`PLAYBACK_PCT (50)`. "On the live edge" is `isLive = props.mode === 'live'
&& props.activeEpoch === null`, the same predicate that already decides the
pill's colour, the in-content live marker and whether the scrub hook may go
live — including the live-lock case, where browsing a past moment sets
`activeEpoch` and correctly counts as not-live.

This is what the operator's *reason* asks for, if not his words: at live the
band above the line is the future (the scroller comments call the spacer "the
immediate FUTURE (times not yet reached)") and nothing lives there, so 10 %
is right; in playback the band above the line is **what plays next**,
including the card just tapped, and 10 % is the wrong layout for it. The
switch is on a fact, not on a distance, so there is no ramp to choose.

**With one latch:** the resolver holds its previous value while `props.mode
=== 'seeking'`. The playback machine enters `seeking` on the first scrub
frame past the 15 s tolerance (`SCRUB_BEGIN` → `mode: 'seeking'`), which is
mid-drag with a finger on the glass — the one moment the spacer must not
move. `seeking` also covers the heatmap strip's drag and the momentum tail
(the reducer commits at momentum end), so the change lands exactly at the
commit, when the list is being repositioned anyway. `gap` and `error` count
as not-live.

### (c) One fixed value for both states (e.g. 30 %) — the zero-mechanism fallback

30 % was the app's own default before the stepper was dropped
(`timeline-indicator.spec.ts` still calls 30 % "the default position";
commit `cea33fda` fixed it at 10 %). At 30 % of 700 = 210 px every phone
preset fits (largest 174 px); the drawer (90 px) still does not. It costs
140 px of live-mode headroom drawn as empty future, which is the thing 10 %
was chosen to avoid, and the operator said explicitly that the live position
is right as it is. Named because it is one constant with no transition and
no jump; not recommended.

## 3. What depends on `indicatorPx`, and which of it follows for free

The structural fact: **no scroll offset anywhere contains the indicator.**
`offsetToEpoch` / `epochToOffset` map offset 0 to `topMs`; the spacer that
puts `topMs` on the line is the indicator itself. Moving the line moves the
spacer, and the same offset still has the same epoch under the line. Hence:

| Consumer | Reads | Derived or copy | On a cursor move |
| --- | --- | --- | --- |
| Follow target (`scrollListTo(mappedEpochToOffset(activeEpoch, …))`) | nothing | derived by construction | unchanged offset, same epoch on the line |
| Scrub mapping (`mappedOffsetToEpoch(offsetY)` in `use-timeline-scrub`) | nothing | derived | unchanged |
| Live-edge decision (`atLiveEdge(topMs − epoch)`) | nothing | derived | unchanged |
| Content height (`timelineContentHeightPx`) | prop | derived | `spacer + day + (viewport − spacer)` — **total height is invariant** at every pct where the trailing room beats the footer (pct < 90 %); no clamp, no scroll event, last addressable offset reachable at every value (the four-percentage spec already proves it) |
| Mount band (`syncBand`, `mountBand({ viewportTopPx: −spacer })`) | prop | derived | re-selected once |
| Ticks (`ticksInBand({ futurePx })`) | prop | derived | future rows fill the taller spacer |
| Cards (`ClusterSlot top = topPx + spacer`), gap markers, activity column, in-content live marker | prop | derived | every mounted card re-renders **once** (its `top` prop changed) — fine at a discrete transition, ruinous per frame |
| Fan overlay (`openFan` centreY) | prop at call time | derived | — |
| Cursor line + pill rows (`TimelineView`, `top: indicator.offsetPx`) | prop | derived | paint order untouched: line under the cards, pill above |
| `ClipsStatusNote` (`clipsNoteTopPx`) | prop | derived | the "no clips" sentence stands mid-body in playback; acceptable, worth a glance |
| Heatmap (`cursorFraction`, `HeatmapBar`) | **nothing** | independent | not a dependent at all — verified, no indicator prop reaches it |
| Expansion / detent (`buildExpansionMap`, `nearestClusterId`) | `activeEpoch` | independent | — |
| Commit log line (`seek committed`, `indicatorPx` field) | closure | copy, informational | logs the value in force — correct |
| **`use-timeline-scrub.ts` `maxScroll`** for `nearOldestEnd` | `indicatorPxRef` | **stale copy** | `indicatorPx + max(viewport, bottomSpan) − viewport` is the pre-fix content formula: already **630 px short** of the real max scroll at 10 %, would be 350 short at 50 %. Harmless direction (asks for a day earlier) but it varies with the cursor for no reason. Replace with `timelineMaxScrollOffsetPx`. The fake in `clips-back-scroll.spec.ts:83` mirrors the stale formula — the "fake supplies what production forgot" shape. |

Prose that would go stale (delete or reword, not annotate):
`timeline-indicator.ts` ("always rests a fixed tenth"), `timeline-cursor.ts`
header ("pinned at a fixed tenth"), `timeline-content-height.ts` ("pinned at
`FIXED_INDICATOR_POSITION_PCT`"), `TheaterTimeline.tsx` ("single, fixed at
10%"), `settings-clusters.spec.ts:29`, and the already-wrong
`timeline-indicator.spec.ts` "30% (the default position)".

## 4. Would a simpler answer serve him better?

| Option | What it does | Why not / why |
| --- | --- | --- |
| Snap to the card's **centre** instead of its start | seeks `start + sizePx/2` of axis | changes what plays: skips 3.9 min at the default zoom, 59 min at 12h. The operator called the start "giustamente". |
| Keep the cursor, make the snap **scroll elsewhere** | one-off scroll with the card centred | the position is then not under the cursor — the cursor stops marking the position (the D62 family of lies); and the playback follow re-issues `scrollListTo(epochToOffset(activeEpoch))` on the next report, undoing it within a second. Making it stick means changing the follow to keep the position under a line that is not at 10 % — which **is** moving the cursor. |
| Hang the card **below** the start again | top edge on the anchor | reverts a deliberate fix in `event-cluster.ts` ("hung it BELOW the track it describes, over the time before the subject existed"). |
| One constant, 30 % | §2(c) | fits phones, not the drawer; wastes live headroom the operator wants kept. |
| **Two states, 10 % live / 50 % otherwise, held during `seeking`** | §2(b) | fits everything measured; no knob; every consumer derives; one latch. |
| Derived non-live value (`clamp(sizePx + gap + pill, 10 %, 50 %)`) | "one card above the line" | principled but varies with density and body width, and the operator asked for half. A future reader understands "live → 10, else → 50" without a derivation. |

A future reader: the two-state rule is one sentence and one fact. The
continuous version needs a paragraph about ramps, and the first question it
raises — "why is the cursor somewhere else after I zoomed / after I left it
paused?" — has no good answer.

## 5. Stability: does the cursor drift while nothing is touched?

The clock: `TheaterTimeline` runs `setInterval(() => setNowMs(Date.now()),
1000)`; `topMs = nowMs`, and the playback follow effect lists `topMs` in its
deps, so **in `playback` mode the list is re-scrolled once a second** to
`epochToOffset(activeEpoch, topMs)` — while paused too (`paused` is a flag,
the mode stays `playback`). Card layout is snapped to the pixel grid
(`layoutAnchorMs`), so cards re-lay out only when a whole pixel moves.

- **Two-state rule:** `isLive` does not change with the clock. No drift.
- **Continuous, pixel ramp (10 → 50 % over one viewport):** the paused
  position's offset grows at `60 / secPerPx` px/min, and the cursor follows
  at 0.4 of that:

  | Zoom | 1 px = | offset growth | cursor creep |
  | --- | ---: | ---: | ---: |
  | 12h | 52.9 s | 1.13 px/min | 0.45 px/min |
  | 3h | 8.8 s | 6.80 px/min | 2.7 px/min |
  | **1h (default)** | **3.5 s** | **17 px/min** | **6.8 px/min (408 px/h)** |
  | 30m | 1.8 s | 34 px/min | 13.6 px/min |

  Visible creep inside a minute at the default zoom; the whole ramp is spent
  in 41 min. While playing at 1× the distance is constant, so it only
  creeps when paused — the worst kind of intermittent.
- **Continuous, time ramp (over one hour behind live):** 4.7 px/min at every
  zoom, same conclusion.

## 6. The one artefact that remains, and the transitions

Keeping the position under a line that moved by Δ means the content moves by
Δ on screen — inherent, not avoidable by any offset trick (shifting the
offset by Δ instead would put an older instant under the line, i.e. a seek
nobody asked for). Δ = 40 % × 700 = **280 px** on a phone.

| Transition | When the mode flips | What the operator sees |
| --- | --- | --- |
| Cluster tap / heatmap tap / date pick / detail "go to" from live | at the seek | the follow relocates the list by hundreds–thousands of px anyway; the extra Δ is invisible |
| Hand scrub from live, released in the past | `seeking` from the first frame (held), `playback` at the commit | **content shifts 280 px down at the release**, position preserved under the line. The only new artefact. A fine-mode commit already issues a realign `scrollListTo` at that moment. |
| Go-live | immediately, while `scrollListTo(0, animated)` runs | content shifts 280 px up on top of the animated scroll; the player remounts anyway. Could be deferred until the programmatic scroll settles (`programmaticRef` already tracks that). |
| Live lock: browse / clear | at the browse | same as a tap |

Softening the release shift is possible later without touching geometry:
`LayoutAnimation.configureNext` on the transition (Fabric supports it on
both platforms; no-op on web), or one wrapper `View` with `top: spacer` that
all positioned children move into, animated as a single value. Not needed
for the first cut.

## Recommendation and cost

Build the operator's mechanism, in its two-state form (§2b).

1. `timeline-indicator.ts` — replace `FIXED_INDICATOR_POSITION_PCT` with
   `LIVE_INDICATOR_POSITION_PCT = 10`, `PLAYBACK_INDICATOR_POSITION_PCT = 50`
   and a pure `resolveIndicatorPct(previous, { mode, atLiveEdge })` that
   returns `previous` while `mode === 'seeking'`. Spec: the four cases, the
   hold, and the live-lock case. ~30 lines + spec.
2. `TheaterTimeline.tsx` — a ref/latch feeding the resolver from
   `props.mode` and `isLive`; `indicatorPx = indicatorOffsetPx(viewportHeight,
   pct)`. Everything below it is already a prop. ~15 lines.
3. `use-timeline-scrub.ts` — `maxScroll` from `timelineMaxScrollOffsetPx`
   (needs `contentBottomInset` or the footer height threaded, or accept the
   trailing-room term without it — the spec pins which); fix the mirror in
   `clips-back-scroll.spec.ts`. A leftover to remove regardless of this
   feature.
4. Add 50 to the percentages in `timeline-content-height.spec.ts`'s "follows
   the cursor percentage" case; add a source guard that no file references a
   `FIXED_INDICATOR_POSITION_PCT`.
5. Six prose sites in §3.
6. Not a setting. The per-user stepper was removed at the operator's request
   (`cea33fda`); these are two constants.

Deferred: animating the 280 px release shift; deferring the go-live shrink
to the scroll's settle. Neither changes geometry, both are additive.

What this does not fix: a card of our own recording tapped at its page zero
now shows whole; in clips mode the compressed axis follows the same spacer
and the same rule, and the clip cursor arm being removed today is orthogonal.
