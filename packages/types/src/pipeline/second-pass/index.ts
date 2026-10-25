// The second detector pass's pure planning (small-subject recovery, the D396
// motion-crop recipe): crop plans, the crop→result remap, the crop-only class
// floor and the fusion. Shared by the live runner and the offline accuracy eval.
export * from './small-subject-recovery.js'
export * from './motion-crop-plan.js'
