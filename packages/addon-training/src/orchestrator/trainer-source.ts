/**
 * The trainer every job runs: the Hugging Face repo `camstack/camstack-trainer`
 * at ONE commit (D807). Pinned here, recorded on every job and echoed in
 * `result.json`, so a run is reproducible and its Corresponding Source is the
 * repo at that revision. Bumping it is a code change: publish the trainer
 * (`hf/camstack-trainer/` → the HF repo), then set the new commit sha here.
 */
import type { TrainerSourceRef } from '@camstack/types'

export const TRAINER_SOURCE: TrainerSourceRef = {
  repo: 'camstack/camstack-trainer',
  revision: 'ebeed67a296241fcb5b0d97cf7c85dd12a743db8',
}
