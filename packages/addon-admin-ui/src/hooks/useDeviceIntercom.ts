/**
 * Browser-side WebRTC client for the `intercom` capability.
 *
 * Lifecycle (orchestrated inside `start()`):
 *   1. `getUserMedia({audio: true})` — prompt mic permission on the
 *       user's first interaction. Stash the resulting `MediaStream`
 *       so `stop()` can release it.
 *   2. `intercom.startSession({deviceId})` (server-side) — server
 *       creates the werift peer, opens the audio-codec decode session,
 *       opens the Reolink talk channel, returns `{sessionId, sdpOffer}`.
 *   3. Build a browser `RTCPeerConnection`; add the mic track sendonly;
 *       `setRemoteDescription(offer)`; `createAnswer()`;
 *       `setLocalDescription(answer)`.
 *   4. `intercom.handleAnswer({deviceId, sessionId, sdpAnswer})`. ICE
 *       takes a few hundred ms; once `connected`, audio flows.
 *
 * `stop()` reverses everything: tells the server to close (best-
 * effort), closes the local PeerConnection, releases the mic.
 *
 * Failure modes the hook surfaces directly via the `error` field:
 *   - mic permission denied (`NotAllowedError`)
 *   - no mic device (`NotFoundError`)
 *   - server-side cap failure (audio-codec missing, camera offline,
 *     intercom not advertised) — bubbles the original error message
 *
 * The hook is intentionally low-level — it doesn't render anything.
 * The `IntercomPanel` UI component owns presentation (button states,
 * permission prompts, pulsating mic indicator).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  useIntercomHandleAnswer,
  useIntercomStartSession,
  useIntercomStopSession,
} from '@camstack/ui-library'
export type IntercomState =
  | 'idle'
  | 'requesting-mic'
  | 'starting'
  | 'connecting'
  | 'talking'
  | 'stopping'
  | 'error'

export interface UseDeviceIntercom {
  state: IntercomState
  /** Live error message — null when no error. Cleared on next `start`. */
  error: string | null
  /** Start a talk session. Idempotent: `start` while already running
   *  resolves silently. */
  start: () => Promise<void>
  /** End the talk session. Idempotent. */
  stop: () => Promise<void>
  /** True while the underlying browser peer is connected and audio
   *  is flowing. Maps to `state === 'talking'`. */
  isTalking: boolean
}

export function useDeviceIntercom(deviceId: number | null): UseDeviceIntercom {
  const [state, setState] = useState<IntercomState>('idle')
  const [error, setError] = useState<string | null>(null)

  // Refs keep the browser-side resources outside React state so we
  // don't re-render on every ICE state change. The TS-only refs also
  // sidestep the "stale closure" problem in the cleanup effect — the
  // cleanup reaches the latest references regardless of when the
  // effect ran.
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  const startMutation = useIntercomStartSession()
  const handleAnswerMutation = useIntercomHandleAnswer()
  const stopMutation = useIntercomStopSession()

  const teardownLocal = useCallback(() => {
    if (pcRef.current) {
      try {
        pcRef.current.close()
      } catch {
        /* swallow */
      }
      pcRef.current = null
    }
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) {
        try {
          t.stop()
        } catch {
          /* swallow */
        }
      }
      streamRef.current = null
    }
    sessionIdRef.current = null
  }, [])

  const stop = useCallback(async () => {
    // Re-clicking stop while ALREADY stopping is allowed — the symptom
    // we used to ship was "button frozen on spinner" when the server
    // stopMutation hung. The fix below caps the wait so we always
    // reach 'idle' even if the server never acknowledges. Idle is
    // the only state we early-return from.
    if (state === 'idle') return
    setState('stopping')
    const sessionId = sessionIdRef.current
    if (sessionId && deviceId !== null) {
      // Race the server's stop against a hard 2s timeout. The server
      // session has its own 30s idle reaper so an orphan is harmless;
      // local resources (mic / RTCPeerConnection) MUST be released
      // immediately so the operator gets visual feedback.
      const SERVER_STOP_TIMEOUT_MS = 2_000
      try {
        await Promise.race([
          stopMutation.mutateAsync({ deviceId, sessionId }),
          new Promise<void>((_, rej) =>
            setTimeout(() => rej(new Error('server stopSession timeout')), SERVER_STOP_TIMEOUT_MS),
          ),
        ])
      } catch (err) {
        console.warn('[intercom] server stopSession failed (continuing teardown)', err)
      }
    }
    teardownLocal()
    if (mountedRef.current) {
      setState('idle')
      setError(null)
    }
  }, [state, deviceId, stopMutation, teardownLocal])

  const start = useCallback(async () => {
    if (deviceId === null) return
    if (state !== 'idle' && state !== 'error') return
    setError(null)

    let stream: MediaStream | null = null
    let pc: RTCPeerConnection | null = null
    let sessionId: string | null = null

    try {
      // 1. Mic permission. The browser remembers the grant — this
      //    only prompts on first use per origin. We request
      //    `audio: true` with no constraints so the browser picks
      //    its default capture pipeline (most aligned with what
      //    Opus expects: 48kHz mono).
      setState('requesting-mic')
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      streamRef.current = stream

      // 2. Server-side session bootstrap. The tRPC mutation
      //    surfaces the error from the cap directly — no need to
      //    re-translate.
      setState('starting')
      const offer = await startMutation.mutateAsync({ deviceId })
      sessionId = offer.sessionId
      sessionIdRef.current = sessionId

      // 3. Browser PeerConnection. Bare config — STUN/TURN come
      //    from the server SDP if relevant; for LAN-only intercom
      //    no ICE servers are needed. Adding mic as `sendrecv`
      //    matches the server's transceiver direction (sendrecv
      //    on the camera-facing leg).
      setState('connecting')
      pc = new RTCPeerConnection()
      pcRef.current = pc

      // Forward ICE state to the public state field. We only flip
      // to 'talking' on `connected`; intermediate states stay as
      // 'connecting' from the user's POV.
      pc.oniceconnectionstatechange = () => {
        if (!mountedRef.current) return
        const s = pc!.iceConnectionState
        if (s === 'connected' || s === 'completed') {
          setState('talking')
        } else if (s === 'failed' || s === 'closed' || s === 'disconnected') {
          // Auto-stop on a failed connection. The server's session
          // will eventually be reaped by its 30s idle, but we
          // explicitly tear down so the operator gets immediate
          // feedback.
          if (mountedRef.current) {
            setError(s === 'failed' ? 'WebRTC connection failed' : null)
            void stop()
          }
        }
      }

      // Add mic tracks (audio-only). The server expects sendrecv
      // on the audio m-line — adding tracks at this stage means
      // the answer SDP carries them in the right direction.
      for (const track of stream.getAudioTracks()) {
        pc.addTrack(track, stream)
      }

      // 4. SDP exchange. The server's offer carries audio sendrecv;
      //    we set it as remote, build the answer locally, send it
      //    back via `handleAnswer`. ICE then completes asynchronously.
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdpOffer })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      const localSdp = pc.localDescription?.sdp ?? answer.sdp ?? ''
      await handleAnswerMutation.mutateAsync({
        deviceId,
        sessionId,
        sdpAnswer: localSdp,
      })
      // State flips to 'talking' from the ICE callback above once
      // ICE completes.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[intercom] start failed', err)
      // Clean up local resources before surfacing the error so a
      // failed start doesn't leak the mic stream.
      if (pc) {
        try {
          pc.close()
        } catch {
          /* swallow */
        }
      }
      if (stream) {
        for (const t of stream.getTracks()) {
          try {
            t.stop()
          } catch {
            /* swallow */
          }
        }
      }
      pcRef.current = null
      streamRef.current = null
      // Best-effort server-side stop — the session may have been
      // partially opened.
      if (sessionId !== null) {
        try {
          await stopMutation.mutateAsync({ deviceId, sessionId })
        } catch {
          /* swallow */
        }
      }
      sessionIdRef.current = null
      if (mountedRef.current) {
        setError(msg)
        setState('error')
      }
    }
  }, [deviceId, state, startMutation, handleAnswerMutation, stopMutation, stop])

  // Cleanup on unmount — always teardown so the mic isn't held
  // hostage by a navigation away from the page.
  //
  // CRITICAL: re-arm `mountedRef.current = true` on every effect
  // entry. The cleanup sets it to false (correctly — async work
  // for the OLD deviceId must not write state for the NEW deviceId),
  // but without re-arming on the new effect run the ref stays false
  // for the rest of the component's life. Symptom: `stop()` finishes
  // its server mutation + teardown but the trailing
  // `if (mountedRef.current) setState('idle')` is a no-op, so state
  // never leaves 'stopping' and the in-stream toolbar / IntercomPanel
  // button stays highlighted. Triggered by ANY deps-driven cleanup,
  // e.g. `intercomAvailable` flipping false→true once the feature
  // probe lands.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const sessionId = sessionIdRef.current
      if (sessionId !== null && deviceId !== null) {
        // Best-effort server stop — the React tree is being torn
        // down so we can't await this. The mutation runs on the
        // tRPC client's queue; the server's idle reaper will catch
        // any orphans.
        stopMutation.mutate({ deviceId, sessionId })
      }
      // Mirror `teardownLocal` inline (the closure captures the
      // refs, not the function which may be stale on unmount).
      if (pcRef.current) {
        try {
          pcRef.current.close()
        } catch {
          /* swallow */
        }
        pcRef.current = null
      }
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) {
          try {
            t.stop()
          } catch {
            /* swallow */
          }
        }
        streamRef.current = null
      }
      sessionIdRef.current = null
    }
    // We intentionally don't depend on `stopMutation` — its identity
    // changes every render but its `mutate` method is stable.
  }, [deviceId])

  return {
    state,
    error,
    start,
    stop,
    isTalking: state === 'talking',
  }
}
