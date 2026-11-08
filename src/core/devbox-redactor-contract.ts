export type { DevboxRedactionBoundary } from '../shared/devbox-errors'

export const DEVBOX_REDACTION_TARGETS = [
  'diagnostic',
  'log',
  'telemetry',
  'support-bundle',
  'job-output'
] as const

export type DevboxRedactionTarget = (typeof DEVBOX_REDACTION_TARGETS)[number]

export type DevboxBundleDisposition = 'included-in-default-bundle' | 'excluded-from-default-bundle'

export type DevboxRedactionLimits = Readonly<{
  maxDepth: number
  maxNodes: number
  maxStringLength: number
}>

export const DEVBOX_REDACTOR_DEFAULT_LIMITS: DevboxRedactionLimits = Object.freeze({
  maxDepth: 32,
  maxNodes: 10_000,
  maxStringLength: 32_768
})

export type DevboxRedactionOptions = Partial<DevboxRedactionLimits>

export type DevboxRedactedRecord = Readonly<{
  target: DevboxRedactionTarget
  value: unknown
  bundleDisposition: DevboxBundleDisposition
}>

export type DevboxSensitiveWorkloadClassification = Readonly<{
  kind: 'job-output'
  bundleDisposition: 'excluded-from-default-bundle'
  reason: 'sensitive-workload'
}>
