/**
 * Auto tune (D745, D755): the static-hardware × measured-latency recommender
 * of ONE detector family for the whole cluster, sized by a capacity floor
 * (no load input), and the shapes of its plan. See `recommend.ts`.
 */
export * from './hardware-class.js'
export * from './detector-performance.js'
export * from './accelerator-compute.js'
export * from './recommend.js'
export * from './plan-schemas.js'
