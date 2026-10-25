import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
const token = process.argv[2]
const wsClient = createWSClient({
  url: 'ws://localhost:4443/trpc',
  connectionParams: () => ({ token }),
})
const trpc = createTRPCClient({ links: [wsLink({ client: wsClient, transformer: superjson })] })
const events = []
const sub = trpc.live.onEvent.subscribe(
  { category: 'benchmark.progress' },
  {
    onData: (event) => {
      events.push(event)
      console.log('EVENT iter=' + event.data.iteration)
    },
    onError: (err) => console.error('ERR', err.message),
    onStarted: () => console.log('STARTED'),
  },
)
await new Promise((r) => setTimeout(r, 2000))
console.log('firing runBenchmark...')
const result = await trpc.addons.custom.mutate({
  addonId: 'benchmark',
  action: 'runBenchmark',
  input: {
    nodeId: 'hub',
    stepId: 'object-detection',
    modelId: 'yolov9t',
    iterations: 2,
    warmup: 0,
  },
})
console.log('DONE mean=' + result.latency.mean)
await new Promise((r) => setTimeout(r, 2000))
console.log('TOTAL_EVENTS=' + events.length)
sub.unsubscribe()
wsClient.close()
process.exit(0)
