import type { AwslEvent } from "./events.js";

export type RunTimingStatus =
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "paused";
export type CallTimingStatus =
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "reused";

export interface AttemptTiming {
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly resumed: boolean;
  readonly status: RunTimingStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs: number;
}

export interface CallTiming {
  readonly attemptSeq: number;
  readonly callId: string;
  readonly callSeq: number;
  readonly label?: string;
  readonly phase?: string;
  readonly status: CallTimingStatus;
  readonly scheduledAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly queueMs?: number;
  readonly durationMs?: number;
  readonly elapsedMs?: number;
  readonly retries: number;
  readonly outcome?: string;
}

export interface PhaseCallTiming {
  readonly callId: string;
  readonly label?: string;
  readonly durationMs?: number;
  readonly endedAt?: string;
}

export interface PhaseTiming {
  readonly attemptSeq: number;
  readonly name: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly elapsedMs: number;
  readonly activeMs: number;
  readonly callMs: number;
  readonly callCount: number;
  readonly maxParallelism: number;
  readonly longestCall?: PhaseCallTiming;
  readonly lastCall?: PhaseCallTiming;
}

export interface RunTiming {
  readonly version: 1;
  readonly status: RunTimingStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly observedAt: string;
  /** First attempt start through the latest terminal/observed event, including resume gaps. */
  readonly elapsedMs: number;
  /** Sum of attempt runtimes; excludes time between a terminal attempt and resume. */
  readonly activeMs: number;
  readonly idleMs: number;
  /** Union of live call intervals within each attempt. Reused calls contribute zero. */
  readonly callActiveMs: number;
  readonly attempts: readonly AttemptTiming[];
  readonly phases: readonly PhaseTiming[];
  readonly calls: readonly CallTiming[];
}

interface MutableAttempt {
  attemptId: string;
  attemptSeq: number;
  resumed: boolean;
  status: RunTimingStatus;
  startedAt: string;
  startedMs: number;
  endedAt?: string;
  endedMs?: number;
}

interface MutableCall {
  attemptSeq: number;
  callId: string;
  callSeq: number;
  label?: string;
  phase?: string;
  status: CallTimingStatus;
  scheduledAt: string;
  scheduledMs: number;
  startedAt?: string;
  startedMs?: number;
  endedAt?: string;
  endedMs?: number;
  retries: number;
  outcome?: string;
}

interface Interval {
  start: number;
  end: number;
}

const terminalRunTypes = new Map<string, RunTimingStatus>([
  ["run.completed", "completed"],
  ["run.failed", "failed"],
  ["run.killed", "killed"],
  ["run.paused", "paused"],
]);
const terminalCallTypes = new Map<string, CallTimingStatus>([
  ["call.completed", "completed"],
  ["call.failed", "failed"],
  ["call.reused", "reused"],
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function validTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : undefined;
}

function callKey(attemptSeq: number, callId: string): string {
  return `${attemptSeq}:${callId}`;
}

function duration(start: number, end: number): number {
  return Math.max(0, end - start);
}

function intervalStats(intervals: readonly Interval[]): {
  activeMs: number;
  maxParallelism: number;
} {
  const valid = intervals.filter((value) => value.end >= value.start);
  if (valid.length === 0) return { activeMs: 0, maxParallelism: 0 };
  const ordered = [...valid].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let activeMs = 0;
  let unionStart = ordered[0]?.start ?? 0;
  let unionEnd = ordered[0]?.end ?? 0;
  for (const current of ordered.slice(1)) {
    if (current.start > unionEnd) {
      activeMs += unionEnd - unionStart;
      unionStart = current.start;
      unionEnd = current.end;
    } else {
      unionEnd = Math.max(unionEnd, current.end);
    }
  }
  activeMs += unionEnd - unionStart;

  const edges = valid
    .flatMap((value) => [
      { at: value.start, delta: 1 },
      { at: value.end, delta: -1 },
    ])
    .sort((left, right) => left.at - right.at || left.delta - right.delta);
  let parallelism = 0;
  let maxParallelism = 0;
  for (const edge of edges) {
    parallelism += edge.delta;
    maxParallelism = Math.max(maxParallelism, parallelism);
  }
  return { activeMs, maxParallelism };
}

function terminalStatus(
  type: string,
  data: Record<string, unknown>,
): RunTimingStatus | undefined {
  const status = data.status;
  if (
    status === "completed" ||
    status === "failed" ||
    status === "killed" ||
    status === "paused"
  )
    return status;
  return terminalRunTypes.get(type);
}

/**
 * Derive a provider-neutral timing summary from awsl lifecycle events.
 *
 * The calculation is deliberately event-schema preserving: it consumes V1 events
 * without adding durable fields or affecting replay keys, so it also works for old
 * runs whose events predate this summary API.
 */
export function summarizeRunTiming(
  events: readonly AwslEvent[],
): RunTiming | null {
  const attempts: MutableAttempt[] = [];
  const calls: MutableCall[] = [];
  const callsByKey = new Map<string, MutableCall>();
  let currentAttempt: MutableAttempt | undefined;
  let observedAt: string | undefined;
  let observedMs: number | undefined;

  for (const event of events) {
    const eventMs = validTimestamp(event.timestamp);
    if (eventMs === undefined) continue;
    observedAt = event.timestamp;
    observedMs = eventMs;
    const data = record(event.data) ?? {};
    if (event.type === "run.started") {
      const attemptId =
        typeof data.attemptId === "string" ? data.attemptId : undefined;
      const attemptSeq = safeInteger(data.attemptSeq);
      if (attemptId === undefined || attemptSeq === undefined) continue;
      currentAttempt = {
        attemptId,
        attemptSeq,
        resumed: data.resumed === true,
        status: "running",
        startedAt: event.timestamp,
        startedMs: eventMs,
      };
      attempts.push(currentAttempt);
      continue;
    }
    if (currentAttempt === undefined) continue;
    const runStatus = terminalStatus(event.type, data);
    if (runStatus !== undefined && event.type.startsWith("run.")) {
      currentAttempt.status = runStatus;
      currentAttempt.endedAt = event.timestamp;
      currentAttempt.endedMs = eventMs;
      continue;
    }
    const callId = typeof data.callId === "string" ? data.callId : undefined;
    const callSeq = safeInteger(data.callSeq);
    if (callId === undefined || callSeq === undefined) continue;
    const key = callKey(currentAttempt.attemptSeq, callId);
    if (event.type === "call.scheduled") {
      const call: MutableCall = {
        attemptSeq: currentAttempt.attemptSeq,
        callId,
        callSeq,
        ...(typeof data.label === "string" ? { label: data.label } : {}),
        ...(typeof data.phase === "string" ? { phase: data.phase } : {}),
        status: "scheduled",
        scheduledAt: event.timestamp,
        scheduledMs: eventMs,
        retries: 0,
      };
      calls.push(call);
      callsByKey.set(key, call);
      continue;
    }
    const call = callsByKey.get(key);
    if (call === undefined) continue;
    if (event.type === "call.started") {
      call.status = "running";
      call.startedAt = event.timestamp;
      call.startedMs = eventMs;
      continue;
    }
    if (event.type === "call.retrying") {
      call.retries += 1;
      continue;
    }
    const callStatus = terminalCallTypes.get(event.type);
    if (callStatus === undefined) continue;
    call.status = callStatus;
    call.endedAt = event.timestamp;
    call.endedMs = eventMs;
    if (typeof data.outcome === "string") call.outcome = data.outcome;
  }

  const firstAttempt = attempts[0];
  if (
    firstAttempt === undefined ||
    observedAt === undefined ||
    observedMs === undefined
  )
    return null;
  const lastAttempt = attempts.at(-1) as MutableAttempt;
  const endedAt = lastAttempt.endedAt;
  const endMs = lastAttempt.endedMs ?? observedMs;
  const activeMs = attempts.reduce(
    (total, attempt) =>
      total + duration(attempt.startedMs, attempt.endedMs ?? observedMs),
    0,
  );
  const elapsedMs = duration(firstAttempt.startedMs, endMs);
  const callIntervals = calls.flatMap((call): Interval[] =>
    call.startedMs === undefined
      ? []
      : [{ start: call.startedMs, end: call.endedMs ?? observedMs }],
  );

  const callSummaries: CallTiming[] = calls.map((call) => ({
    attemptSeq: call.attemptSeq,
    callId: call.callId,
    callSeq: call.callSeq,
    ...(call.label === undefined ? {} : { label: call.label }),
    ...(call.phase === undefined ? {} : { phase: call.phase }),
    status: call.status,
    scheduledAt: call.scheduledAt,
    ...(call.startedAt === undefined ? {} : { startedAt: call.startedAt }),
    ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
    ...(call.startedMs === undefined
      ? {}
      : { queueMs: duration(call.scheduledMs, call.startedMs) }),
    ...(call.startedMs === undefined || call.endedMs === undefined
      ? {}
      : { durationMs: duration(call.startedMs, call.endedMs) }),
    ...(call.endedMs === undefined
      ? {}
      : { elapsedMs: duration(call.scheduledMs, call.endedMs) }),
    retries: call.retries,
    ...(call.outcome === undefined ? {} : { outcome: call.outcome }),
  }));

  const phaseGroups = new Map<string, CallTiming[]>();
  for (const call of callSummaries) {
    if (call.phase === undefined) continue;
    const key = `${call.attemptSeq}:${call.phase}`;
    const group = phaseGroups.get(key) ?? [];
    group.push(call);
    phaseGroups.set(key, group);
  }
  const phases: PhaseTiming[] = [...phaseGroups.values()].map((group) => {
    const first = group.reduce((left, right) =>
      left.scheduledAt <= right.scheduledAt ? left : right,
    );
    const terminal = group.filter(
      (call): call is CallTiming & { endedAt: string } =>
        call.endedAt !== undefined,
    );
    const last = terminal.reduce<
      (CallTiming & { endedAt: string }) | undefined
    >(
      (left, right) =>
        left === undefined || right.endedAt > left.endedAt ? right : left,
      undefined,
    );
    const phaseEndAt = last?.endedAt ?? observedAt;
    const phaseEndMs = validTimestamp(phaseEndAt) ?? observedMs;
    const intervals = group.flatMap((call): Interval[] => {
      const started =
        call.startedAt === undefined
          ? undefined
          : validTimestamp(call.startedAt);
      if (started === undefined) return [];
      const ended =
        call.endedAt === undefined ? observedMs : validTimestamp(call.endedAt);
      return ended === undefined ? [] : [{ start: started, end: ended }];
    });
    const stats = intervalStats(intervals);
    const longest = group.reduce<CallTiming | undefined>(
      (left, right) =>
        left === undefined || (right.durationMs ?? -1) > (left.durationMs ?? -1)
          ? right
          : left,
      undefined,
    );
    return {
      attemptSeq: first.attemptSeq,
      name: first.phase as string,
      startedAt: first.scheduledAt,
      endedAt: phaseEndAt,
      elapsedMs: duration(
        validTimestamp(first.scheduledAt) ?? phaseEndMs,
        phaseEndMs,
      ),
      activeMs: stats.activeMs,
      callMs: group.reduce((total, call) => total + (call.durationMs ?? 0), 0),
      callCount: group.length,
      maxParallelism: stats.maxParallelism,
      ...(longest?.durationMs === undefined
        ? {}
        : {
            longestCall: {
              callId: longest.callId,
              ...(longest.label === undefined ? {} : { label: longest.label }),
              durationMs: longest.durationMs,
            },
          }),
      ...(last === undefined
        ? {}
        : {
            lastCall: {
              callId: last.callId,
              ...(last.label === undefined ? {} : { label: last.label }),
              endedAt: last.endedAt,
            },
          }),
    };
  });

  return {
    version: 1,
    status: lastAttempt.status,
    startedAt: firstAttempt.startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    observedAt,
    elapsedMs,
    activeMs,
    idleMs: Math.max(0, elapsedMs - activeMs),
    callActiveMs: intervalStats(callIntervals).activeMs,
    attempts: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      attemptSeq: attempt.attemptSeq,
      resumed: attempt.resumed,
      status: attempt.status,
      startedAt: attempt.startedAt,
      ...(attempt.endedAt === undefined ? {} : { endedAt: attempt.endedAt }),
      durationMs: duration(attempt.startedMs, attempt.endedMs ?? observedMs),
    })),
    phases,
    calls: callSummaries,
  };
}
