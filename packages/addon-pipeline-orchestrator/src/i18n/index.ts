import { createAddonI18n } from '@camstack/ui-library'
import en from './en.json'
import it from './it.json'

/** Strings of the Pipeline Orchestrator widgets (namespace = addon id). */
export const { useT, Trans, translate } = createAddonI18n('pipeline-orchestrator', { en, it })
