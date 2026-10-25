import { describe, expect, it } from 'vitest'
import * as pipelineRunnerCap from '../pipeline-runner.cap.js'
import * as streamingShared from '../schemas/streaming-shared.js'
import * as streamBrokerCap from '../stream-broker.cap.js'
import * as webrtcSessionCap from '../webrtc-session.cap.js'

/**
 * The stream-broker's frame-handle plane is removed (D762). Nothing subscribed
 * to it — decoding runs in the per-session decode workers — so every field it
 * fed read 0 / null on every live camera. Neither the methods nor the fields
 * they fed may come back.
 */
const FRAME_PLANE_METHODS = ['subscribeFrames', 'pullFrameHandles', 'unsubscribeFrames']

describe('the broker frame-handle plane is gone (D762)', () => {
  it('stream-broker has no frame-plane methods', () => {
    const methods = Object.keys(streamBrokerCap.streamBrokerCapability.methods)
    expect(methods.filter((m) => FRAME_PLANE_METHODS.includes(m))).toEqual([])
  })

  it('no SubscribeFrames schema is exported', () => {
    const exported = [...Object.keys(streamingShared), ...Object.keys(streamBrokerCap)].filter(
      (k) => /SubscribeFrames|BrokerDecodedClient/.test(k),
    )
    expect(exported).toEqual([])
  })

  it('BrokerStats carries no decode rate, decoded-subscriber count or decoder node', () => {
    const keys = Object.keys(streamingShared.BrokerStatsSchema.shape)
    expect(
      keys.filter((k) => ['decodeFps', 'decodedSubscribers', 'decoderNodeId'].includes(k)),
    ).toEqual([])
  })

  it('listClients has no decoded channel and killClient cannot target one', () => {
    expect(Object.keys(streamBrokerCap.BrokerClientsSchema.shape)).not.toContain('decoded')
    const killInput = streamBrokerCap.streamBrokerCapability.methods.killClient.input
    expect(killInput.safeParse({ brokerId: 'b', channel: 'decoded', handle: 'h' }).success).toBe(
      false,
    )
  })

  it('a webrtc stream choice carries no decode rate', () => {
    expect(Object.keys(webrtcSessionCap.WebrtcStreamChoiceSchema.shape)).not.toContain('decodeFps')
  })
})

describe('a runner device load carries no queue depth nothing measures (D762)', () => {
  it('RunnerLocalLoad.devices[] has no queueDepthTotal', () => {
    const parsed = pipelineRunnerCap.RunnerLocalLoadSchema.shape.devices.unwrap().element
    expect(Object.keys(parsed.shape)).not.toContain('queueDepthTotal')
  })
})
