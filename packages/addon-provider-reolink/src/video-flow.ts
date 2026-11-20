import {
  BaichuanVideoStream,
  CompositeStream,
  ContinuousVideoStream,
  type Rfc4571TcpServer,
} from '@apocaliss92/nodelink-js'

/**
 * Report every video packet a stream server produces. The three stream kinds
 * the server can sit on name the same event differently (`videoFrame` for the
 * native and composite streams, `videoAccessUnit` for the always-on one), so
 * the kind is narrowed by class, not asserted.
 *
 * Returns the unsubscribe. A stream kind this does not know is reported
 * through `onUnknown` and never watched — silence would read as "no video".
 */
export function watchVideoFlow(
  stream: Rfc4571TcpServer['videoStream'],
  onFlow: () => void,
  onUnknown: () => void,
): () => void {
  if (stream instanceof BaichuanVideoStream || stream instanceof CompositeStream) {
    stream.on('videoFrame', onFlow)
    return () => {
      stream.off('videoFrame', onFlow)
    }
  }
  if (stream instanceof ContinuousVideoStream) {
    stream.on('videoAccessUnit', onFlow)
    return () => {
      stream.off('videoAccessUnit', onFlow)
    }
  }
  onUnknown()
  return () => {}
}
