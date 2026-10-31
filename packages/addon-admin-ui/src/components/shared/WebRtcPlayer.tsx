import { useEffect, useRef, useState, useCallback } from 'react'
import { Volume2, VolumeX, RefreshCw, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@camstack/ui-library'

export interface WebRtcPlayerProps {
  serverUrl: string
  streamId: string
  autoPlay?: boolean
  muted?: boolean
  className?: string
  onError?: (error: string) => void
}

type PlayerState = 'connecting' | 'playing' | 'error' | 'disconnected'

const RECONNECT_DELAY_MS = 3000
const MAX_RECONNECT_ATTEMPTS = 5

export function WebRtcPlayer({
  serverUrl,
  streamId,
  autoPlay = true,
  muted: initialMuted = true,
  className = '',
  onError,
}: WebRtcPlayerProps) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const mountedRef = useRef(true)

  const [state, setState] = useState<PlayerState>('connecting')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [isMuted, setIsMuted] = useState(initialMuted)

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  const connect = useCallback(async () => {
    if (!mountedRef.current) return

    cleanup()
    setState('connecting')

    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      })
      pcRef.current = pc

      // Add a transceiver for video (receive-only)
      pc.addTransceiver('video', { direction: 'recvonly' })
      // Optionally receive audio
      pc.addTransceiver('audio', { direction: 'recvonly' })

      pc.ontrack = (event) => {
        if (videoRef.current && event.streams[0]) {
          videoRef.current.srcObject = event.streams[0]
        }
      }

      pc.oniceconnectionstatechange = () => {
        if (!mountedRef.current) return
        const iceState = pc.iceConnectionState
        if (iceState === 'connected' || iceState === 'completed') {
          reconnectAttemptsRef.current = 0
          setState('playing')
        } else if (iceState === 'failed' || iceState === 'disconnected' || iceState === 'closed') {
          setState('disconnected')
          scheduleReconnect()
        }
      }

      // Create SDP offer (WHEP)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      // Wait for ICE gathering to complete
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve()
          return
        }
        const onGatheringChange = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', onGatheringChange)
            resolve()
          }
        }
        pc.addEventListener('icegatheringstatechange', onGatheringChange)
        // Timeout after 5s
        setTimeout(resolve, 5000)
      })

      if (!mountedRef.current) return

      const whepUrl = `${serverUrl}/api/webrtc?src=${encodeURIComponent(streamId)}`
      const response = await fetch(whepUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription?.sdp ?? '',
      })

      if (!response.ok) {
        throw new Error(`WHEP server returned ${response.status}: ${response.statusText}`)
      }

      const answerSdp = await response.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMessage(msg)
      setState('error')
      onError?.(msg)
      scheduleReconnect()
    }
  }, [serverUrl, streamId, cleanup, onError])

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) return
    reconnectAttemptsRef.current += 1
    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) connect()
    }, RECONNECT_DELAY_MS)
  }, [connect])

  useEffect(() => {
    mountedRef.current = true
    reconnectAttemptsRef.current = 0
    connect()
    return () => {
      mountedRef.current = false
      cleanup()
    }
  }, [serverUrl, streamId]) // Re-connect if serverUrl or streamId changes

  const handleManualReconnect = () => {
    reconnectAttemptsRef.current = 0
    connect()
  }

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted
      setIsMuted(videoRef.current.muted)
    }
  }

  return (
    <div className={`relative bg-black overflow-hidden rounded ${className}`}>
      <video
        ref={videoRef}
        autoPlay={autoPlay}
        muted={isMuted}
        playsInline
        className="w-full h-full object-contain"
      />

      {/* Overlay: connecting */}
      {state === 'connecting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-2">
          <RefreshCw className="h-6 w-6 text-foreground-subtle animate-spin" />
          <span className="text-xs text-foreground-subtle">
            {t('shared.webRtcPlayer.connecting', 'Connecting…')}
          </span>
        </div>
      )}

      {/* Overlay: error / disconnected */}
      {(state === 'error' || state === 'disconnected') && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-2">
          <WifiOff className="h-6 w-6 text-danger" />
          <span className="text-xs text-danger text-center px-4">
            {state === 'error'
              ? errorMessage || t('shared.webRtcPlayer.connectionFailed', 'Connection failed')
              : t('shared.webRtcPlayer.streamDisconnected', 'Stream disconnected')}
          </span>
          <Button
            variant="unstyled"
            onClick={handleManualReconnect}
            className="mt-1 inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            {t('shared.webRtcPlayer.reconnect', 'Reconnect')}
          </Button>
        </div>
      )}

      {/* Controls: mute button (only visible while playing) */}
      {state === 'playing' && (
        <div className="absolute bottom-2 right-2">
          <Button
            variant="unstyled"
            onClick={toggleMute}
            title={
              isMuted
                ? t('shared.webRtcPlayer.unmute', 'Unmute')
                : t('shared.webRtcPlayer.mute', 'Mute')
            }
            className="rounded-full p-1.5 bg-black/50 text-white hover:bg-black/70 transition-colors"
          >
            {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </Button>
        </div>
      )}
    </div>
  )
}
