import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * Pipeline bundle — entries (pipeline-runner, detection-pipeline,
 * motion-wasm, audio-analyzer, stream-broker, recorder). Stream-broker ships React widgets so the bundle
 * uses 'framework+ui' externals (react/react-dom/@tanstack/* stay
 * peer-resolved by admin-ui).
 *
 * Native deps (better-sqlite3 via runtime-state, sharp) are already in
 * the preset's COMMON_NATIVE_DEPS so they stay external automatically.
 */
export default buildLibPreset({
  entries: {
    'pipeline-runner/index': 'src/pipeline-runner/index.ts',
    'detection-pipeline/index': 'src/detection-pipeline/index.ts',
    'motion-wasm/index': 'src/motion-wasm/index.ts',
    'audio-analyzer/index': 'src/audio-analyzer/index.ts',
    'stream-broker/index': 'src/stream-broker/index.ts',
    'recorder/index': 'src/recorder/addon/index.ts',
    // Epic C P1: the per-session decode worker (Task 2) is forked by the
    // pipeline-runner (`fork-decode-worker.ts` resolves it at
    // `dist/session-decode/decode-worker-main.js`). The ENTRY is
    // `decode-worker-main.ts`; the worker class it runs is
    // `decode-worker-child.ts`, kept free of process side effects so a test can
    // construct it (D652). node-av stays external (COMMON_NATIVE_DEPS) and is
    // installed with the addon.
    'session-decode/decode-worker-main': 'src/session-decode/decode-worker-main.ts',
    // D228: scrub mp4box parse runs on a worker_threads child so the live
    // restream event loop is not the one walking boxes. Resolved from the
    // inlined stream-broker entry as `./demux-worker-child.js` (sibling of
    // `dist/stream-broker/index.js`) — same trick as decode-worker-child.
    'stream-broker/demux-worker-child': 'src/stream-broker/recorded/demux-worker-child.ts',
  },
  externals: 'self-contained+ui',
})
