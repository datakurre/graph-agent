/**
 * A harness is whatever actually performs a BPMN activity: one Pi turn, one Pi
 * tool call, a graph splice, a shell command.
 *
 * The result shape is the five-key contract the archived Python implementation
 * used, kept verbatim so diagrams and `camunda:outputParameter` expressions stay
 * portable between the two implementations.
 */

export interface HarnessResult {
  status: "success" | "failed";
  summary: string;
  findings: unknown[];
  artifacts: string[];
  next_action: "continue" | "stop";
  /** Free-form detail a harness wants to expose to gateways or the studio. */
  [key: string]: unknown;
}

export interface HarnessContext {
  activityId: string;
  activityName?: string;
  harness: string;
  /** `camunda:properties` on the activity, minus the harness selector. */
  properties: Record<string, string>;
  /** Resolved `camunda:inputParameter` values. */
  input: Record<string, unknown>;
  /** Current process variables. */
  variables: Record<string, unknown>;
  signal?: AbortSignal;
  /** Multi-instance loop index, so parallel instances of one activity can be told apart. */
  instance?: string;
}

export type Harness = (context: HarnessContext) => Promise<HarnessResult>;

export type HarnessRegistry = Record<string, Harness>;

/**
 * Every `HarnessResult` carries these regardless of which harness produced
 * it, so a `zeebe:output source="=status"` (etc.) is always valid no matter
 * what job type the activity names -- see `HARNESS_IO` in harnesses.ts,
 * which enumerates the harness-specific fields on top of these.
 */
export const HARNESS_RESULT_BASE_FIELDS = ["status", "summary", "findings", "artifacts", "next_action"] as const;

export function ok(summary: string, extra: Partial<HarnessResult> = {}): HarnessResult {
  return { status: "success", summary, findings: [], artifacts: [], next_action: "continue", ...extra };
}

export function failed(summary: string, extra: Partial<HarnessResult> = {}): HarnessResult {
  return { status: "failed", summary, findings: [], artifacts: [], next_action: "stop", ...extra };
}

/** A harness that records what it was asked to do. Used by tests and `--dry-run`. */
export function mockHarness(log: HarnessContext[] = []): { harness: Harness; log: HarnessContext[] } {
  const harness: Harness = async (context) => {
    log.push(context);
    return ok(`mock ran ${context.harness} for ${context.activityId}`);
  };
  return { harness, log };
}
