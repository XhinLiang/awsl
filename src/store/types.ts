import type { AwslEvent } from "../core/events.js";
import type {
  AgentResult,
  JsonValue,
  ProviderId,
  ProviderUsage,
} from "../core/types.js";
export type JournalCallState =
  | "scheduled"
  | "started"
  | "completed"
  | "failed"
  | "indeterminate";

export type CompletedPayload =
  | {
      outcome: "result";
      origin: "live" | "reused";
      result: AgentResult;
      value: JsonValue;
      usage: ProviderUsage;
    }
  | {
      outcome: "compatibility-null" | "user-skip";
      origin: "live";
      result: null;
      value: null;
      usage: ProviderUsage;
    };

export interface JournalAttemptRecordV1 {
  version: 1;
  kind: "attempt";
  runId: string;
  attemptId: string;
  attemptSeq: number;
  recordSeq: number;
  sourceSha256: string;
  sourcePath: string;
  recordedAt: string;
}

export interface JournalCallRecordV1 {
  version: 1;
  kind: "call";
  runId: string;
  attemptId: string;
  attemptSeq: number;
  recordSeq: number;
  callSeq: number;
  callId: string;
  key: `v2:${string}`;
  previousKey: string;
  state: JournalCallState;
  completed?: CompletedPayload;
  usage?: ProviderUsage;
  recordedAt: string;
}
export type JournalRecordV1 = JournalAttemptRecordV1 | JournalCallRecordV1;
export interface DurableJournalRecord {
  record: JournalRecordV1;
  durable: true;
}

export interface RunSnapshot {
  readonly [key: string]: JsonValue;
}
export interface RunResultSnapshot {
  readonly [key: string]: JsonValue;
}
export interface SourceSnapshotInput {
  runId: string;
  attemptId: string;
  attemptSeq: number;
  sourcePath: string;
  source: string;
}
export interface SourceSnapshot {
  path: string;
  manifestPath: string;
  sha256: string;
  sourcePath: string;
  runId: string;
  attemptId: string;
  attemptSeq: number;
}
export interface LockOwner {
  nonce: string;
  pid: number;
  processStartIdentity: string;
}
export interface StoredLockOwner extends LockOwner {
  version: 1;
  acquiredAt: string;
  fileIdentity: {
    dev: number;
    ino: number;
  };
}
export interface RunLock {
  release(): Promise<void>;
}

export interface RunStore {
  beginAttempt(
    record: Omit<JournalAttemptRecordV1, "recordSeq" | "recordedAt">,
  ): Promise<DurableJournalRecord>;
  appendCall(
    record: Omit<JournalCallRecordV1, "recordSeq" | "recordedAt">,
  ): Promise<DurableJournalRecord>;
  loadJournal(): Promise<readonly JournalRecordV1[]>;
  writeRun(snapshot: RunSnapshot): Promise<void>;
  writeResult(snapshot: RunResultSnapshot): Promise<void>;
  writeSourceSnapshot(input: SourceSnapshotInput): Promise<SourceSnapshot>;
  appendEvent(event: AwslEvent): Promise<void>;
  rawEventSink(
    provider: ProviderId,
  ): undefined | ((event: unknown) => Promise<void>);
  acquireRunLock(owner: LockOwner): Promise<RunLock>;
}
