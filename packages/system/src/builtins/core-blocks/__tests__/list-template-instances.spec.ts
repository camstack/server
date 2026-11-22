import {
  builtinAutomationTemplate,
  generateAutomationBlock,
  instantiateAutomationTemplate,
  LINKED_TRIGGER_TEMPLATE_ID,
  linkedTriggerValues,
  type CoreBlock,
  type LinkedTriggerParams,
  type LinkedTriggerSource,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { listTemplateInstances } from '../automation-template-instances.js'

function linked(id: string, params: LinkedTriggerParams, enabled = true): CoreBlock {
  const payload = builtinAutomationTemplate(LINKED_TRIGGER_TEMPLATE_ID)?.payload
  if (payload === undefined) throw new Error('setup: linked-trigger is not shipped')
  const made = instantiateAutomationTemplate(
    LINKED_TRIGGER_TEMPLATE_ID,
    payload,
    linkedTriggerValues(params),
  )
  if (!made.ok) throw new Error('setup: the instance does not expand')
  return {
    id,
    name: `Linked ${id}`,
    code: generateAutomationBlock({
      name: `Linked ${id}`,
      recipe: made.recipe,
    }),
    enabled,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'test',
    status: 'running',
    lastChangedAt: 1,
  }
}

const press = (deviceId: number): LinkedTriggerSource => ({
  kind: 'device-fired',
  deviceId,
  sourceIds: ['1'],
})

describe('listTemplateInstances', () => {
  const blocks: CoreBlock[] = [
    linked('lamp', {
      targetDeviceId: 5767,
      action: 'toggle',
      sources: [press(5656)],
    }),
    linked('other', { targetDeviceId: 6001, action: 'on', sources: [press(5656)] }, false),
    {
      ...linked('free', {
        targetDeviceId: 1,
        action: 'on',
        sources: [press(1)],
      }),
      code: 'export default () => {}',
    },
  ]

  it('lists the instances whose COMMANDED device is the one asked for, never a source', () => {
    expect(
      listTemplateInstances(blocks, LINKED_TRIGGER_TEMPLATE_ID, 5767).map((i) => i.blockId),
    ).toEqual(['lamp'])
    // 5656 is the source of both automations and the target of none.
    expect(listTemplateInstances(blocks, LINKED_TRIGGER_TEMPLATE_ID, 5656)).toEqual([])
  })

  it('carries the values the Customize tab edits, and the enabled switch', () => {
    const [lamp] = listTemplateInstances(blocks, LINKED_TRIGGER_TEMPLATE_ID, 5767)
    expect(lamp).toMatchObject({
      blockId: 'lamp',
      enabled: true,
      templateId: LINKED_TRIGGER_TEMPLATE_ID,
      values: {
        target: 5767,
        action: { actionId: 'switch.toggle' },
        when: [{ kind: 'device-fired', deviceId: 5656, sourceIds: ['1'] }],
      },
    })
    expect(listTemplateInstances(blocks, LINKED_TRIGGER_TEMPLATE_ID, 6001)[0]?.enabled).toBe(false)
  })

  it('without a device it lists every instance of the template, and no hand-written automation', () => {
    expect(listTemplateInstances(blocks, LINKED_TRIGGER_TEMPLATE_ID).map((i) => i.blockId)).toEqual(
      ['lamp', 'other'],
    )
    expect(listTemplateInstances(blocks, 'builtin:motion-light')).toEqual([])
  })
})
