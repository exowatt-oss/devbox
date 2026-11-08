export {
  DEVBOX_REDACTION_TARGETS,
  DEVBOX_REDACTOR_DEFAULT_LIMITS
} from './devbox-redactor-contract'
export type {
  DevboxRedactionBoundary,
  DevboxRedactionTarget,
  DevboxBundleDisposition,
  DevboxRedactionLimits,
  DevboxRedactionOptions,
  DevboxRedactedRecord,
  DevboxSensitiveWorkloadClassification
} from './devbox-redactor-contract'

import {
  DEVBOX_REDACTION_TARGETS,
  DEVBOX_REDACTOR_DEFAULT_LIMITS,
  type DevboxBundleDisposition,
  type DevboxRedactedRecord,
  type DevboxRedactionLimits,
  type DevboxRedactionOptions,
  type DevboxRedactionTarget,
  type DevboxSensitiveWorkloadClassification
} from './devbox-redactor-contract'
import { redactDevboxNode } from './devbox-redactor-containers'

function assertLimit(name: keyof DevboxRedactionLimits, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`)
  }
  return value
}

function normalizeLimits(options: DevboxRedactionOptions): DevboxRedactionLimits {
  return Object.freeze({
    maxDepth: assertLimit('maxDepth', options.maxDepth ?? DEVBOX_REDACTOR_DEFAULT_LIMITS.maxDepth),
    maxNodes: assertLimit('maxNodes', options.maxNodes ?? DEVBOX_REDACTOR_DEFAULT_LIMITS.maxNodes),
    maxStringLength: assertLimit(
      'maxStringLength',
      options.maxStringLength ?? DEVBOX_REDACTOR_DEFAULT_LIMITS.maxStringLength
    )
  })
}

function normalizeTarget(target: DevboxRedactionTarget): DevboxRedactionTarget {
  if (!DEVBOX_REDACTION_TARGETS.includes(target)) {
    throw new TypeError(`Unknown Devbox redaction target: ${String(target)}`)
  }
  return target
}

/** Job stdout/stderr is sensitive workload data, not ordinary support data. */
export function classifyDevboxJobOutput(): DevboxSensitiveWorkloadClassification {
  return {
    kind: 'job-output',
    bundleDisposition: 'excluded-from-default-bundle',
    reason: 'sensitive-workload'
  }
}

export function classifyDevboxBundleDisposition(
  target: DevboxRedactionTarget
): DevboxBundleDisposition {
  return normalizeTarget(target) === 'job-output'
    ? 'excluded-from-default-bundle'
    : 'included-in-default-bundle'
}

/**
 * Recursive, cycle-safe, non-mutating Devbox boundary for logs, diagnostics,
 * telemetry, and support records. `job-output` is still redacted when called,
 * but its bundle disposition remains excluded by contract.
 */
export class DevboxRedactor {
  readonly limits: DevboxRedactionLimits

  constructor(options: DevboxRedactionOptions = {}) {
    this.limits = normalizeLimits(options)
  }

  redact(value: unknown): unknown {
    return redactDevboxNode(value, this.limits)
  }

  redactForTarget(
    value: unknown,
    target: DevboxRedactionTarget = 'diagnostic'
  ): DevboxRedactedRecord {
    const normalizedTarget = normalizeTarget(target)
    return {
      target: normalizedTarget,
      value: this.redact(value),
      bundleDisposition: classifyDevboxBundleDisposition(normalizedTarget)
    }
  }
}

export function redactDevboxValue(value: unknown, options: DevboxRedactionOptions = {}): unknown {
  return new DevboxRedactor(options).redact(value)
}

export function redactDevboxRecord(
  value: unknown,
  target: DevboxRedactionTarget = 'diagnostic',
  options: DevboxRedactionOptions = {}
): DevboxRedactedRecord {
  return new DevboxRedactor(options).redactForTarget(value, target)
}
