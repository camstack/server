---
name: track-review
description: Review recent tracks for a wrong class and curate the corrected frames into the re-training set — triage suspects, look at each, give a verdict, show the operator the write list, then apply it. Use for "find tracks the detector got wrong", "this animal is labelled as the wrong species", "build a retrain collection from recent mistakes", or when setting up the `track_review_*` MCP tools.
---

# Track review

A detector's mistakes are the most valuable training data it will ever get, and
they hide inside thousands of correct tracks. This procedure finds the likely
mistakes, has a model (and then the operator) look at them, and writes only the
confirmed ones into the re-training set with the right boxes.

It is the MCP tools `track_review_triage`, `track_review_frame`,
`track_review_plan`, `track_review_apply` of `@camstack/mcp-develop`. Without the
MCP, the same hub methods can be called by hand; the order below still holds.

## 0. Configure the MCP

The server reads three environment variables. Nothing else, no flags.

| Variable | Meaning |
| --- | --- |
| `CAMSTACK_HUB_URL` | Hub address (`https://hub.local:4443`; a bare host is completed to the default port). |
| `CAMSTACK_HUB_TOKEN_FILE` | Path to a file holding ONE token, mode 0600 (preferred). `CAMSTACK_HUB_TOKEN` also works but leaks into process listings. |
| `CAMSTACK_HUB_CA_FILE` | PEM of the hub's CA or pinned certificate, for a self-signed hub. |

TLS verification is never turned off: a certificate error is fixed by naming the
CA, not by disabling the check. Triage and frame need a normal token;
**apply needs admin permissions** and shows the hub's own refusal if the token
lacks it. Tokens are never printed.

```json
{ "mcpServers": { "camstack-develop": {
  "command": "npx", "args": ["@camstack/mcp-develop"],
  "env": { "CAMSTACK_HUB_URL": "https://hub.local:4443",
           "CAMSTACK_HUB_TOKEN_FILE": "/home/me/.camstack/review.token",
           "CAMSTACK_HUB_CA_FILE": "/home/me/.camstack/hub-ca.pem" } } } }
```

## 1. Triage — rank, do not judge

`track_review_triage { hours, deviceIds?, classes?, excludeInTraining? }` pages the
window (default 72 h, at most 14 days), scores every video track, and returns the
top suspects with their features and `cameraName`, plus a **random control sample**
of tracks that scored low.

Each row carries `inTraining: { collections } | null`, read from the retrain corpus
in one bounded pass (never per track). Suspects already in the corpus are skipped
by default and counted in `skippedInTraining`; pass `excludeInTraining: false` to
see them anyway. If `trainingTruncated` is true the corpus was only partly read, so
`null` is not proof.

`few-observations` is **not evaluated by triage**: the slim rows it reads carry no
position history and fetching it would cost a call per track. The result says so in
`signalsNotEvaluated`; `track_review_frame` shows the observation count for one track.

The score is a sum of cheap signals. None of them says "wrong"; together they say
"look here first":

| Signal | Why it matters | Known failure mode of the signal |
| --- | --- | --- |
| `class-label-mismatch` | the sub-label belongs to a different macro class than the track's class | rare; a real reclassification, not noise |
| `suspect-label` | a label small or unusual subjects are commonly mistaken for (cat, bird, teddy bear, sheep) | fires on every genuine one too; read it with the score |
| `low-label-score` | weak classification confidence | weak is not wrong; a good label can score low in the dark |
| `very-short` / `few-observations` | seen for a moment, often a mis-detection or an edge | a fast mover is also short |
| `tiny-subject` | the trajectory box is a sliver of the frame | a distant subject is legitimately tiny |
| `static-subject` | a person or vehicle that never moved: the profile of a picture of one | a person sitting still is real |
| `class-changed` | the track was reclassified during its life | usually the fix working |

Confusions worth looking for on purpose, because they repeat:

- a small, light-coloured dog read as a cat or a bird, worst when it is far away;
- vehicles and people on a **television or monitor** (they appear, never leave
  the screen, and the same programme repeats);
- a person read as another class when partly hidden or lying down, and the
  reverse: a coat, a plant or a shadow read as a person;
- the same subject split into two tracks with different classes.

Raise or lower `minScore`, pass `suspectLabels`, or restrict `classes` to chase
one confusion. If `fetched.truncated` is true the window was cut by the page
cap: narrow it.

## 2. Look at each suspect

`track_review_frame { deviceId, trackId }` returns a clean frame as an image
(bounded in size) with the features and the trajectory envelope. Judge the
subject in the picture, not the label. If the frame is missing or too small to
tell, the verdict is `unsure`.

A whole-scene frame (key frame, full frame) is preferred, and the envelope is in
that image's coordinates. If only the track's thumbnail CROP fits the size bound,
`imageSpace` is `crop`, a `WARNING` says so, and the envelope is withheld: it is in
full-frame coordinates and the crop's rectangle is unknown, so it would not line up.
Raise `maxBytes` to get the full frame.

## 3. Verdicts

| Verdict | Meaning | Written? |
| --- | --- | --- |
| `correct` | the class is right | no |
| `wrong-class` | the subject is something else; say what (`correctClass`) | yes |
| `false-positive` | nothing is there; the model drew a box on a picture, a shadow, a reflection | yes, as a `model_error` box |
| `pipeline-bug` | the class is fine but the track is broken (split, merged, no media) | no — report it |
| `unsure` | cannot tell from the evidence | no — never train on a guess |

**Annotate every subject in the frame.** A frame is evaluated as ground truth: a
subject left unboxed counts against the detector as a false alarm. So when
reviewing a wrong-class track, box the other people and animals in the same
frame too (`subjects`), and set `complete: true` only when every subject is
boxed. A frame not marked complete is kept but stays out of detector evaluation;
that is the safe default.

## 4. Check the misses: the control sample

The control sample is what keeps the signals honest. Review it exactly like the
suspects. If more than a handful of the control tracks turn out wrong, the
signals are missing a whole kind of mistake: say so, widen the net (lower
`minScore`, add `suspectLabels`) and rerun before trusting the suspect list. The
share of wrong tracks in the control sample is the miss rate — report it
alongside the findings.

## 5. Plan, show, then apply

1. `track_review_plan { verdicts, collectionName? }` — local, writes nothing. It
   keeps each verdict's `note`, carries `collectionName` so the plan is
   self-contained, and returns, per track, the steps (flag for training → copy the frame → save the corrected
   boxes → mark complete → add to the collection), the subjects, and the
   verdicts that write nothing with their reason.
2. **Present that write list to the operator and wait.** Name the tracks, the
   classes you will write, the collection, and how many frames will be marked
   complete. This is the only moment to catch a wrong call cheaply.
3. `track_review_apply { plan, collectionName?, confirm: true }` — only after the
   operator agrees. It refuses without `confirm: true` and a collection name:
   the argument if given, else `plan.collectionName` (the argument wins).

Apply is safe to repeat: a frame already copied is reused, a frame that already
has annotations is left alone (`overwrite: true` replaces them — a save replaces
EVERY annotation on the frame), the collection is created once, a track that
fails does not stop the others, and an authorisation failure stops the run and
shows the hub's message. It returns a per-track log and the corpus KPI
(total / annotated / complete frames) before and after; quote both.

A box taken from the pipeline is saved as the pipeline's (`source: 'pipeline'`,
with its model, score and the `origin` it was offered as), so the hub can tell
"kept as drawn" from "relabelled". The save names the frame revision apply read;
if the operator edited the same frame in the admin page meanwhile, the hub
refuses it (`retrain-revision-conflict`) and that track is reported `failed` —
re-plan it rather than forcing it.

### Annotations saved before origins existed

`track_review_backfill_origin { collectionName | frameIds }` is a **dry-run**: per
frame it lists the rows that would get an origin (an EXACT rectangle match against
the pipeline box the hub re-derives), the rows that stay unmatched, and the rows
that already have one. Show that to the operator; only then repeat it with
`confirm: true`. It writes the origin column only and never overwrites an existing
origin. Rows left unmatched keep an approximate review verdict.

## Done when

- every suspect and every control track has a verdict;
- the operator saw the write list before apply;
- the per-track log shows each planned track `done`, or the reason it did not;
- the KPI moved by what was planned and the control-sample miss rate is reported.
