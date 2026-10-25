import { describe, expect, it } from 'vitest'
import type { WyzeCamera, WyzeEvent } from '@apocaliss92/wyze-bridge-js'
import {
  bitrateFor,
  cameraConfigFromCloud,
  codecFromVideoType,
  frameSizeFor,
  isAdoptableCamera,
  latestMotionEvent,
  latestThumbnailUrl,
  stableIdForMac,
} from '../mapping.js'
import { WYZE_BITRATE, WYZE_FRAME_SIZE } from '../constants.js'

const cam: WyzeCamera = {
  mac: '80482C53405B',
  p2pId: 'UID123',
  enr: 'ENRKEY',
  ip: '192.168.10.41',
  nickname: 'Test',
  productModel: 'WYZE_CAKP2JFUS',
  productType: 'Camera',
  dtls: 1,
  firmwareVer: '4.36.14.3497',
  isOnline: true,
}

function event(partial: Partial<WyzeEvent>): WyzeEvent {
  return {
    eventId: 'e1',
    deviceMac: cam.mac,
    deviceModel: cam.productModel,
    timestamp: 1000,
    alarmType: 'motion',
    aiTags: [],
    files: [],
    isRead: false,
    ...partial,
  }
}

describe('codec mapping', () => {
  it('maps videoType to canonical codec', () => {
    expect(codecFromVideoType('H264')).toBe('h264')
    expect(codecFromVideoType('H265')).toBe('h265')
  })
})

describe('frameSize / bitrate mapping', () => {
  it('maps resolution to lib frameSize', () => {
    expect(frameSizeFor('fhd')).toBe(WYZE_FRAME_SIZE.fhd)
    expect(frameSizeFor('hd')).toBe(WYZE_FRAME_SIZE.hd)
    expect(frameSizeFor('low')).toBe(WYZE_FRAME_SIZE.low)
    expect(frameSizeFor('qhd')).toBe(WYZE_FRAME_SIZE.qhd)
  })

  it('maps bitrate knob to lib bitrate', () => {
    expect(bitrateFor('max')).toBe(WYZE_BITRATE.max)
    expect(bitrateFor('sd')).toBe(WYZE_BITRATE.sd)
  })
})

describe('stableIdForMac', () => {
  it('sanitises + lowercases the MAC', () => {
    expect(stableIdForMac('80:48:2C:53:40:5B')).toBe('mac-80482c53405b')
    expect(stableIdForMac('80482C53405B')).toBe('mac-80482c53405b')
  })
})

describe('cameraConfigFromCloud', () => {
  it('reduces the cloud blob to persisted config with defaults', () => {
    const cfg = cameraConfigFromCloud(cam)
    expect(cfg).toMatchObject({
      mac: cam.mac,
      p2pId: cam.p2pId,
      enr: cam.enr,
      ip: cam.ip,
      productModel: cam.productModel,
      dtls: 1,
      resolution: 'fhd',
      bitrate: 'max',
      motionSource: 'cloud',
    })
  })
})

describe('isAdoptableCamera', () => {
  it('accepts a complete blob', () => {
    expect(isAdoptableCamera(cam)).toBe(true)
  })
  it('rejects blobs missing P2P params', () => {
    expect(isAdoptableCamera({ ...cam, p2pId: '' })).toBe(false)
    expect(isAdoptableCamera({ ...cam, ip: '' })).toBe(false)
    expect(isAdoptableCamera({ ...cam, enr: '' })).toBe(false)
  })
})

describe('latestMotionEvent', () => {
  it('returns the newest motion event for the mac', () => {
    const events = [
      event({ eventId: 'a', timestamp: 1000, aiTags: ['person'] }),
      event({ eventId: 'b', timestamp: 3000, aiTags: ['vehicle'] }),
      event({ eventId: 'c', timestamp: 2000 }),
    ]
    const got = latestMotionEvent(events, cam.mac)
    expect(got?.eventId).toBe('b')
    expect(got?.timestamp).toBe(3000)
    expect(got?.aiTags).toEqual(['vehicle'])
  })

  it('ignores non-motion alarms and other macs', () => {
    const events = [
      event({ alarmType: 'sound', timestamp: 5000 }),
      event({ deviceMac: 'OTHER', timestamp: 9000 }),
      event({ eventId: 'm', alarmType: 'motion', timestamp: 1000 }),
    ]
    expect(latestMotionEvent(events, cam.mac)?.eventId).toBe('m')
  })

  it('returns null when no motion present', () => {
    expect(latestMotionEvent([event({ alarmType: 'sound' })], cam.mac)).toBeNull()
  })
})

describe('latestThumbnailUrl', () => {
  it('returns the newest image url for the mac', () => {
    const events = [
      event({
        timestamp: 1000,
        files: [{ fileId: 'f1', type: 'image', url: 'http://old.jpg', status: 2 }],
      }),
      event({
        timestamp: 5000,
        files: [{ fileId: 'f2', type: 'image', url: 'http://new.jpg', status: 2 }],
      }),
    ]
    expect(latestThumbnailUrl(events, cam.mac)).toBe('http://new.jpg')
  })

  it('skips non-image files and returns null when none', () => {
    const events = [
      event({ files: [{ fileId: 'v', type: 'video', url: 'http://clip.mp4', status: 2 }] }),
    ]
    expect(latestThumbnailUrl(events, cam.mac)).toBeNull()
  })
})
