import { type AddonTFunction, createAddonI18n, type TranslationKey } from '@camstack/ui-library'
import en from './en.json'
import it from './it.json'

/** Strings of the agent dashboard (namespace = addon id). */
export const { useT, Trans, translate } = createAddonI18n('agent-ui', { en, it })

export type AgentUiKey = TranslationKey<typeof en>
export type AgentUiT = AddonTFunction<AgentUiKey>
