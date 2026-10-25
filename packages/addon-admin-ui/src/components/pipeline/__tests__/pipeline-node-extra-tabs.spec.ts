/**
 * Pipeline → Nodo extra tabs. Models live in Model Studio, not here.
 *
 * A production change that would fail this test: putting `models` back on
 * the node pane (the old NodeModelsTab embed of ModelsPage).
 */
import { describe, expect, it } from 'vitest'
import { PIPELINE_NODE_EXTRA_TAB_IDS } from '../pipeline-node-extra-tabs'

describe('PIPELINE_NODE_EXTRA_TAB_IDS', () => {
  it('does not include a Models tab — Model Studio owns catalog and nodes', () => {
    expect(PIPELINE_NODE_EXTRA_TAB_IDS).toEqual(['assignments', 'tree', 'engines', 'logs'])
    expect(PIPELINE_NODE_EXTRA_TAB_IDS).not.toContain('models')
  })
})
