/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect } from 'vitest'
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen } from '@testing-library/react'
import React from 'react'
import type { CameraSensorsStatus } from '@camstack/types'
import { StreamsMotionBlock } from '../config-blocks'
import type { OrchestratorCameraSettings } from '../camera-card-model'

expect.extend(jestDomMatchers)

function makeSettings(motionSources: readonly string[]): OrchestratorCameraSettings {
  return {
    detectionMode: 'on-motion',
    detectionStreamProfile: null,
    detectionFps: null,
    motionSources,
    motionFps: null,
    motionCooldownMs: null,
    motionStreamProfile: null,
    audioMode: null,
    pipelineNodeId: null,
    decoderNodeId: null,
    audioNodeId: null,
    overriddenKeys: new Set<string>(),
  }
}

function renderBlock(
  motionSources: readonly string[],
  cameraSensors: CameraSensorsStatus | undefined,
): void {
  render(
    <StreamsMotionBlock
      streams={[]}
      brokerProfiles={undefined}
      settings={makeSettings(motionSources)}
      motionEnabled={null}
      motionFpsLive={null}
      cameraSensors={cameraSensors}
    />,
  )
}

/** The value cell of the KV row whose label is exactly `label`. */
function rowValue(label: string): HTMLElement {
  const labelCell = screen.getByTitle(label)
  const value = labelCell.nextElementSibling
  if (!(value instanceof HTMLElement)) throw new Error(`no value cell for ${label}`)
  return value
}

describe('StreamsMotionBlock — camera sensors row (D672)', () => {
  it('names a missing attached sensor by its ref', () => {
    renderBlock(['onboard'], {
      state: 'configured',
      sensors: [
        {
          addonId: 'ha-x',
          stableId: 'ha:gone',
          mode: 'in-addition',
          state: 'missing',
          reason: 'not found',
        },
      ],
    })
    expect(rowValue('Camera sensors')).toHaveTextContent('ha-x/ha:gone — missing')
  })

  it('an older node that sent no field says so, never "none attached"', () => {
    renderBlock(['onboard'], undefined)
    expect(rowValue('Camera sensors')).toHaveTextContent('status unavailable from this node')
  })
})

describe('StreamsMotionBlock — motion source labels (D672)', () => {
  it('the onboard motion source reads Camera sensors, never the raw wire value', () => {
    renderBlock(['onboard'], { state: 'not-configured' })
    const motionSrc = rowValue('Motion src')
    expect(motionSrc).toHaveTextContent('Camera sensors')
    expect(motionSrc).not.toHaveTextContent('onboard')
  })

  it('a value this build does not know is shown as itself', () => {
    renderBlock(['analyzer', 'newer-node-source'], { state: 'not-configured' })
    expect(rowValue('Motion src')).toHaveTextContent(
      'Frame-diff Analyzer (motion addon) + newer-node-source',
    )
  })
})
