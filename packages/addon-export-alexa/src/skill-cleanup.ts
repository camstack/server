/**
 * What deleting a skill removes. The `skills` row itself is deleted by the instances provider;
 * the rows keyed by the same id belong to the skill and go with it: its account links (and the
 * keychain markers bound to that row), what it exposed, and its hidden state (ingress token,
 * push mirrors). Without this a later skill minted on the same id would inherit them.
 */
import type { RecordKindHandle } from '@camstack/types'
import type { SkillExportsBody, SkillLinksBody, SkillStateBody } from './skill-records.js'

export interface SkillRowHandles {
  readonly links: Pick<RecordKindHandle<SkillLinksBody>, 'delete'>
  readonly exports: Pick<RecordKindHandle<SkillExportsBody>, 'delete'>
  readonly state: Pick<RecordKindHandle<SkillStateBody>, 'delete'>
}

export async function deleteSkillRows(handles: SkillRowHandles, instanceId: string): Promise<void> {
  await handles.links.delete(instanceId)
  await handles.exports.delete(instanceId)
  await handles.state.delete(instanceId)
}
