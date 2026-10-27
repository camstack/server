# @camstack/mcp-develop

MCP server (stdio) for CamStack plugin authors. Run it with
`npx @camstack/mcp-develop`; it wraps `@camstack/develop`.

## Workspace tools

Operate on the local CamStack workspace only (no hub): `list_addons`,
`get_addon`, `list_capabilities`, `get_capability`, `who_provides`,
`list_examples`, `find_example`, `validate_addon`, `scaffold_addon`,
`scaffold_cap_stub`, `extend_addon`, `list_skills`, `get_skill`.

## Track review tools

Find tracks whose class is wrong and curate them into the re-training set. The
procedure, the signals and the verdict vocabulary are in the `track-review`
skill (`get_skill track-review`).

| Tool | Hub access | What it does |
| --- | --- | --- |
| `track_review_triage` | read | Rank recent video tracks by how likely the class is wrong; returns suspects with features, `cameraName` and `inTraining` (suspects already in the retrain corpus are skipped, counted in `skippedInTraining`, unless `excludeInTraining: false`) and a random control sample of non-suspects. `few-observations` is not evaluated here (slim rows carry no positions); `signalsNotEvaluated` says so. Walks the hub one camera at a time (1000 rows/page), bounded at 20000 tracks or 60 s; a partial read is announced in the first text block and in `fetched.truncatedBy`. |
| `track_review_frame` | read | The best clean frame of one track as an image (size-bounded) plus its features and trajectory envelope. Prefers a whole-scene frame; on a thumbnail-crop fallback the envelope is withheld (`imageSpace: crop`) with a warning, since its full-frame coordinates do not map onto the crop. |
| `track_review_plan` | none | Turn verdicts into the exact write plan, keeping each verdict's `note` and an optional `collectionName`. Local, writes nothing. |
| `track_review_apply` | **write** | Execute a plan: flag tracks for training, copy a frame, save corrected annotations, mark complete, add to a named collection. Refuses without `confirm: true` and a collection name (the `collectionName` argument, else `plan.collectionName`); idempotent; never replaces existing annotations unless `overwrite: true`; returns a per-track log and the corpus KPI before and after. A box copied from the pipeline is saved as the pipeline's (`source: 'pipeline'`, with its model, score and an `origin` snapshot), and the save names the frame revision it read so a frame changed elsewhere is refused. |
| `track_review_backfill_origin` | **write** (dry-run by default) | For annotations saved before origins existed, reconstruct each row's origin by EXACT rectangle match against the pipeline box the hub re-derives for its frame. Name a collection or `frameIds`. Returns per frame the rows that would get an origin, the rows that stay unmatched (approximate) and those that already have one; writes (`backfillRetrainOrigins`, origin column only) only with `confirm: true`, and never overwrites an existing origin. |

Hub methods used (`pipelineAnalytics.*` unless noted): `deviceManager.listAll`,
`listRecentTracks`, `getTrack`, `listTrackMedia`, `getTrackMedia`,
`getRetrainCorpusKpi`, `listRetrainCollections`, `listRetrainFrames`,
`listRetrainAnnotations`; writes: `setTrackFlags`, `selectRetrainFrames`,
`saveRetrainAnnotations`, `backfillRetrainOrigins`, `setRetrainFrameComplete`,
`createRetrainCollection`, `addRetrainFramesToCollection`; also reads
`listRetrainCorpusPage` (the backfill walks a collection with it).

### Configuration

| Variable | Meaning |
| --- | --- |
| `CAMSTACK_HUB_URL` | Hub address, e.g. `https://hub.local:4443`. |
| `CAMSTACK_HUB_TOKEN_FILE` | File holding one token (preferred). `CAMSTACK_HUB_TOKEN` also works. |
| `CAMSTACK_HUB_CA_FILE` | PEM of the hub's CA / pinned certificate for a self-signed hub. |

TLS verification is never disabled. `track_review_apply` and `track_review_backfill_origin` (with `confirm`) need an admin token;
the hub's refusal is shown as-is. Tokens never appear in output.

```json
{ "mcpServers": { "camstack-develop": {
  "command": "npx", "args": ["@camstack/mcp-develop"],
  "env": { "CAMSTACK_HUB_URL": "https://hub.local:4443",
           "CAMSTACK_HUB_TOKEN_FILE": "/home/me/.camstack/review.token",
           "CAMSTACK_HUB_CA_FILE": "/home/me/.camstack/hub-ca.pem" } } } }
```

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/mcp-develop` on npm.

## Requirements

- Node.js >=24.

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
