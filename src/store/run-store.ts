import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";

import { COMPATIBILITY_PROFILE } from "../compat/profile.js";
import { AwslError } from "../core/errors.js";
import type { AwslEvent } from "../core/events.js";
import { strictJsonClone } from "../core/strict-json.js";
import type { ProviderId } from "../core/types.js";
import { parseUniqueJson } from "../core/unique-json.js";
import { canonicalJson } from "./canonical-json.js";
import {
  type AtomicFileOps,
  type StoreFile,
  atomicWrite,
  createPrivateDirectory,
  existingPrivateDirectory,
  fullWrite,
  fullWriteAt,
  immutableWrite,
  nodeFileOps,
  privateDirectory,
  regularFile,
} from "./file-ops.js";
import {
  type JournalReadResult,
  readJournalJsonl,
  readJournalJsonlBytes,
  validateJournalRecord,
  validateJournalRecords,
} from "./jsonl.js";
import { redactJson } from "./redact.js";
import type {
  DurableJournalRecord,
  JournalAttemptRecordV1,
  JournalCallRecordV1,
  JournalRecordV1,
  LockOwner,
  RunLock,
  RunResultSnapshot,
  RunSnapshot,
  SourceSnapshot,
  SourceSnapshotInput,
  StoredLockOwner,
} from "./types.js";

const fail = (message: string, cause?: unknown) =>
  new AwslError("PERSISTENCE_ERROR", message, { recoverable: false, cause });
const token = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_LOCK_BYTES = 16 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const STREAM_READ_CHUNK_BYTES = 64 * 1024;
const MAX_STREAM_LINE_BYTES =
  COMPATIBILITY_PROFILE.providerProcess.maxNdjsonLineBytes;
const bytes = (value: string) => Buffer.from(value, "utf8");
const boundedBytes = (value: string, maximumBytes: number): Buffer => {
  const content = bytes(value);
  if (content.byteLength > maximumBytes)
    throw fail("state file exceeds the byte limit");
  return content;
};
export const boundedStreamLine = (
  value: string,
  maximumBytes = MAX_STREAM_LINE_BYTES,
): Buffer => {
  const content = bytes(value);
  if (content.byteLength > maximumBytes)
    throw fail("state stream line exceeds the byte limit");
  return Buffer.concat([content, bytes("\n")], content.byteLength + 1);
};
export function projectedJournalBytes(
  input: {
    statSize: number;
    validEndOffset: number;
    tailKind: JournalReadResult["tailKind"];
    appendBytes: number;
  },
  maximumBytes = MAX_JOURNAL_BYTES,
): number {
  if (
    ![
      input.statSize,
      input.validEndOffset,
      input.appendBytes,
      maximumBytes,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    input.validEndOffset > input.statSize
  )
    throw fail("invalid journal byte accounting");
  const currentBytes =
    input.tailKind === "invalid-final-fragment"
      ? input.validEndOffset
      : input.statSize + (input.tailKind === "valid-final-without-lf" ? 1 : 0);
  if (
    currentBytes > maximumBytes ||
    input.appendBytes > maximumBytes - currentBytes
  )
    throw fail("state file exceeds the byte limit");
  return currentBytes + input.appendBytes;
}
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const noExist = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  ((error as { cause?: unknown }).cause !== undefined &&
    noExist((error as { cause: unknown }).cause));
function parseEventLine(line: string, expectedRunId: string): AwslEvent {
  try {
    const value = strictJsonClone(
      parseUniqueJson(line),
      "run event",
    ) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new TypeError();
    const event = value as Record<string, unknown>;
    const timestamp =
      typeof event.timestamp === "string"
        ? Date.parse(event.timestamp)
        : Number.NaN;
    if (
      Object.keys(event).length !== 5 ||
      !["version", "type", "timestamp", "runId", "data"].every((key) =>
        Object.hasOwn(event, key),
      ) ||
      event.version !== 1 ||
      typeof event.type !== "string" ||
      !event.type ||
      event.runId !== expectedRunId ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString() !== event.timestamp
    )
      throw new TypeError();
    canonicalJson(event.data);
    return Object.freeze(event as unknown as AwslEvent);
  } catch (error) {
    throw fail("invalid run event", error);
  }
}

function parseEventStream(
  content: Buffer,
  expectedRunId: string,
): readonly AwslEvent[] {
  let source: string;
  try {
    source = fatalUtf8.decode(content);
  } catch (error) {
    throw fail("invalid run event stream", error);
  }
  if (!source) return Object.freeze([]);
  const terminated = source.endsWith("\n");
  const lines = source.split("\n");
  if (terminated) lines.pop();
  const events: AwslEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line, "utf8") > MAX_STREAM_LINE_BYTES)
      throw fail("state stream line exceeds the byte limit");
    try {
      events.push(parseEventLine(line, expectedRunId));
    } catch (error) {
      if (!terminated && index === lines.length - 1) break;
      throw error;
    }
  }
  return Object.freeze(events);
}
function validatedLockOwner(
  owner: LockOwner,
  now: () => Date,
): { nonce: string; contents: Buffer } {
  try {
    if (
      typeof owner !== "object" ||
      owner === null ||
      Array.isArray(owner) ||
      types.isProxy(owner) ||
      (Object.getPrototypeOf(owner) !== Object.prototype &&
        Object.getPrototypeOf(owner) !== null)
    )
      throw fail("invalid lock owner");
    const fields = Object.getOwnPropertyDescriptors(owner);
    if (
      Reflect.ownKeys(owner).length !== 3 ||
      !["nonce", "pid", "processStartIdentity"].every((key) => key in fields) ||
      Object.values(fields).some((field) => !("value" in field))
    )
      throw fail("invalid lock owner");
    const nonce = fields.nonce?.value;
    const pid = fields.pid?.value;
    const processStartIdentity = fields.processStartIdentity?.value;
    if (
      typeof nonce !== "string" ||
      !token.test(nonce) ||
      !Number.isSafeInteger(pid) ||
      (pid ?? 0) <= 0 ||
      typeof processStartIdentity !== "string" ||
      !processStartIdentity ||
      processStartIdentity.includes("\0") ||
      Buffer.byteLength(processStartIdentity, "utf8") > 1024
    )
      throw fail("invalid lock owner");
    const acquiredAt = now().toISOString();
    return {
      nonce,
      contents: bytes(
        canonicalJson({
          version: 1,
          nonce,
          pid: pid as number,
          processStartIdentity,
          acquiredAt,
        }),
      ),
    };
  } catch (error) {
    throw error instanceof AwslError
      ? error
      : fail("invalid lock owner", error);
  }
}

function capturedStoredLockOwner(value: StoredLockOwner): StoredLockOwner {
  try {
    const parsed = strictJsonClone(value, "stored run lock") as Record<
      string,
      unknown
    >;
    const identity = parsed.fileIdentity;
    const processStartIdentity = parsed.processStartIdentity;
    const acquiredAt = parsed.acquiredAt;
    const acquiredAtMillis =
      typeof acquiredAt === "string" ? Date.parse(acquiredAt) : Number.NaN;
    const device =
      identity !== null && typeof identity === "object"
        ? (identity as Record<string, unknown>).dev
        : undefined;
    const inode =
      identity !== null && typeof identity === "object"
        ? (identity as Record<string, unknown>).ino
        : undefined;
    if (
      Object.keys(parsed).length !== 6 ||
      parsed.version !== 1 ||
      typeof parsed.nonce !== "string" ||
      !token.test(parsed.nonce) ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      typeof processStartIdentity !== "string" ||
      processStartIdentity.length === 0 ||
      processStartIdentity.includes("\0") ||
      Buffer.byteLength(processStartIdentity, "utf8") > 1024 ||
      typeof acquiredAt !== "string" ||
      !Number.isFinite(acquiredAtMillis) ||
      new Date(acquiredAtMillis).toISOString() !== acquiredAt ||
      identity === null ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      Object.keys(identity).length !== 2 ||
      !Number.isSafeInteger(device) ||
      (device as number) < 0 ||
      !Number.isSafeInteger(inode) ||
      (inode as number) < 0
    )
      throw new TypeError();
    return parsed as unknown as StoredLockOwner;
  } catch (error) {
    throw fail("invalid verified run lock identity", error);
  }
}

function sameStoredLock(
  left: StoredLockOwner,
  right: StoredLockOwner,
): boolean {
  return (
    left.version === right.version &&
    left.nonce === right.nonce &&
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    left.acquiredAt === right.acquiredAt &&
    left.fileIdentity.dev === right.fileIdentity.dev &&
    left.fileIdentity.ino === right.fileIdentity.ino
  );
}

export interface FileRunStoreOptions {
  root: string;
  runId: string;
  rawCapture?: boolean;
  ops?: AtomicFileOps;
  now?: () => Date;
}
export interface RunStorePaths {
  runDir: string;
  journal: string;
  events: string;
  run: string;
  result: string;
  scripts: string;
  providers: string;
  lock: string;
}

export class FileRunStore {
  readonly paths: RunStorePaths;
  #ops: AtomicFileOps;
  #runId: string;
  #rawCapture: boolean;
  #now: () => Date;
  #nextRecordSeq = 0;
  #queue = Promise.resolve();
  #poison: AwslError | undefined;
  #lockHeld = false;
  #lockIndeterminate = false;
  #releaseStarted = false;
  #sourceBindings = new Map<string, SourceSnapshot>();
  #streamRepairDone = new Set<string>();
  private constructor(options: FileRunStoreOptions) {
    if (!token.test(options.runId)) throw fail("unsafe run identifier");
    const runDir = join(options.root, options.runId);
    this.paths = {
      runDir,
      journal: join(runDir, "journal.jsonl"),
      events: join(runDir, "events.jsonl"),
      run: join(runDir, "run.json"),
      result: join(runDir, "result.json"),
      scripts: join(runDir, "scripts"),
      providers: join(runDir, "providers"),
      lock: join(runDir, ".lock"),
    };
    this.#ops = options.ops ?? nodeFileOps;
    this.#runId = options.runId;
    this.#rawCapture = options.rawCapture === true;
    this.#now = options.now ?? (() => new Date());
  }
  static async open(options: FileRunStoreOptions): Promise<FileRunStore> {
    const store = new FileRunStore(options);
    await privateDirectory(store.#ops, store.paths.runDir);
    await privateDirectory(store.#ops, store.paths.scripts);
    if (store.#rawCapture)
      await privateDirectory(store.#ops, store.paths.providers);
    return store;
  }
  static async create(options: FileRunStoreOptions): Promise<FileRunStore> {
    const store = new FileRunStore(options);
    await createPrivateDirectory(store.#ops, store.paths.runDir);
    await privateDirectory(store.#ops, store.paths.scripts);
    if (store.#rawCapture)
      await privateDirectory(store.#ops, store.paths.providers);
    return store;
  }
  static async openExisting(
    options: FileRunStoreOptions,
  ): Promise<FileRunStore> {
    const store = new FileRunStore(options);
    await existingPrivateDirectory(store.#ops, store.paths.runDir);
    await existingPrivateDirectory(store.#ops, store.paths.scripts);
    if (store.#rawCapture)
      await existingPrivateDirectory(store.#ops, store.paths.providers);
    return store;
  }
  async #refreshSequence(): Promise<void> {
    try {
      const loaded = readJournalJsonlBytes(
        await this.#readVerified(this.paths.journal),
        this.#runId,
      );
      this.#nextRecordSeq = loaded.records.length;
    } catch (error) {
      if (noExist(error)) return;
      throw error;
    }
  }
  async #readVerified(
    path: string,
    maximumBytes = MAX_JOURNAL_BYTES,
  ): Promise<Buffer> {
    let file: StoreFile;
    try {
      file = await this.#ops.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      throw error instanceof AwslError
        ? error
        : fail("could not open state file", error);
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
        throw fail("state file is not a private regular file");
      if (
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size > maximumBytes
      )
        throw fail("state file exceeds the byte limit");
      const content = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < content.length) {
        const read = await file.read(
          content,
          offset,
          content.length - offset,
          offset,
        );
        if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead <= 0)
          throw fail("short state file read");
        offset += read.bytesRead;
      }
      return content;
    } finally {
      await file.close();
    }
  }
  async #readJsonSnapshot(
    path: string,
    label: "run snapshot" | "result snapshot",
  ): Promise<RunSnapshot | RunResultSnapshot> {
    try {
      const source = fatalUtf8.decode(
        await this.#readVerified(path, MAX_STATE_BYTES),
      );
      const value = strictJsonClone(parseUniqueJson(source), label);
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value as { runId?: unknown }).runId !== this.#runId
      )
        throw new TypeError();
      return value as RunSnapshot | RunResultSnapshot;
    } catch (error) {
      if (
        error instanceof AwslError &&
        error.code === "PERSISTENCE_ERROR" &&
        error.message === "state file exceeds the byte limit"
      )
        throw error;
      throw fail(`invalid ${label}`, error);
    }
  }
  async #readLockFile(): Promise<StoredLockOwner> {
    let file: StoreFile;
    try {
      file = await this.#ops.open(
        this.paths.lock,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      throw error instanceof AwslError
        ? error
        : fail("could not open run lock", error);
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        !Number.isSafeInteger(stat.size) ||
        stat.size <= 0 ||
        stat.size > MAX_LOCK_BYTES
      )
        throw fail("invalid run lock");
      const content = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < content.length) {
        const read = await file.read(
          content,
          offset,
          content.length - offset,
          offset,
        );
        if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead <= 0)
          throw fail("short run lock read");
        offset += read.bytesRead;
      }
      const path = await this.#ops.lstat(this.paths.lock);
      if (
        path.isSymbolicLink() ||
        path.dev !== stat.dev ||
        path.ino !== stat.ino
      )
        throw fail("run lock identity changed");
      let parsed: unknown;
      try {
        parsed = strictJsonClone(
          parseUniqueJson(fatalUtf8.decode(content)),
          "run lock",
        );
      } catch (error) {
        throw fail("invalid run lock", error);
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        throw fail("invalid run lock");
      const lock = parsed as Record<string, unknown>;
      const acquiredAtMillis =
        typeof lock.acquiredAt === "string"
          ? Date.parse(lock.acquiredAt)
          : Number.NaN;
      if (
        Object.keys(lock).length !== 5 ||
        lock.version !== 1 ||
        typeof lock.nonce !== "string" ||
        !token.test(lock.nonce) ||
        !Number.isSafeInteger(lock.pid) ||
        (lock.pid as number) <= 0 ||
        typeof lock.processStartIdentity !== "string" ||
        lock.processStartIdentity.length === 0 ||
        lock.processStartIdentity.includes("\0") ||
        Buffer.byteLength(lock.processStartIdentity, "utf8") > 1024 ||
        typeof lock.acquiredAt !== "string" ||
        !Number.isFinite(acquiredAtMillis) ||
        new Date(acquiredAtMillis).toISOString() !== lock.acquiredAt ||
        ![
          "version",
          "nonce",
          "pid",
          "processStartIdentity",
          "acquiredAt",
        ].every((key) => Object.hasOwn(lock, key))
      )
        throw fail("invalid run lock");
      return Object.freeze({
        version: 1,
        nonce: lock.nonce,
        pid: lock.pid as number,
        processStartIdentity: lock.processStartIdentity,
        acquiredAt: lock.acquiredAt,
        fileIdentity: Object.freeze({ dev: stat.dev, ino: stat.ino }),
      });
    } finally {
      await file.close();
    }
  }
  #serialized<T>(
    operation: () => Promise<T>,
    allowPoisoned = false,
  ): Promise<T> {
    const running = this.#queue.then(async () => {
      if (!allowPoisoned && this.#poison !== undefined) throw this.#poison;
      try {
        return await operation();
      } catch (error) {
        if (allowPoisoned)
          throw error instanceof AwslError
            ? error
            : fail("journal persistence failed", error);
        this.#poison =
          error instanceof AwslError
            ? error
            : fail("journal persistence failed", error);
        throw this.#poison;
      }
    });
    this.#queue = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }
  #requireLock(): void {
    if (!this.#lockHeld || this.#lockIndeterminate)
      throw fail("store write requires an active verified run lock");
  }
  async #openJournalForAppend(): Promise<{
    file: StoreFile | undefined;
    stat: Awaited<ReturnType<StoreFile["stat"]>> | undefined;
    loaded: JournalReadResult;
  }> {
    let file: StoreFile;
    try {
      file = await this.#ops.open(
        this.paths.journal,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (noExist(error))
        return {
          file: undefined,
          stat: undefined,
          loaded: { records: [], validEndOffset: 0, tailKind: "clean" },
        };
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0)
        throw fail("journal is not regular");
      if (stat.size > MAX_JOURNAL_BYTES)
        throw fail("state file exceeds the byte limit");
      const content = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < content.byteLength) {
        const { bytesRead } = await file.read(
          content,
          offset,
          content.byteLength - offset,
          offset,
        );
        if (bytesRead <= 0) throw fail("short journal read");
        offset += bytesRead;
      }
      const loaded = readJournalJsonlBytes(content, this.#runId);
      return { file, stat, loaded };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async #repairHeldJournalTail(
    file: StoreFile | undefined,
    stat: Awaited<ReturnType<StoreFile["stat"]>> | undefined,
    loaded: JournalReadResult,
  ): Promise<void> {
    if (file === undefined || stat === undefined) return;
    if (loaded.tailKind === "invalid-final-fragment") {
      await file.truncate(loaded.validEndOffset);
      await file.sync();
    } else if (loaded.tailKind === "valid-final-without-lf") {
      await fullWriteAt(file, bytes("\n"), stat.size);
      await file.sync();
    }
  }
  async #appendBytes(
    path: string,
    content: Uint8Array,
    maximumBytes?: number,
  ): Promise<void> {
    if (path !== this.paths.journal && !this.#streamRepairDone.has(path)) {
      await this.#repairGenericStream(path);
      this.#streamRepairDone.add(path);
    }
    let created = false;
    try {
      await regularFile(this.#ops, path);
    } catch (error) {
      if (!noExist(error)) throw error;
      created = true;
    }
    const file = await this.#ops.open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw fail("journal is not regular");
      if (
        maximumBytes !== undefined &&
        (!Number.isSafeInteger(stat.size) ||
          stat.size < 0 ||
          content.byteLength > maximumBytes - stat.size)
      )
        throw fail("state file exceeds the byte limit");
      await file.chmod(0o600);
      await fullWrite(file, content);
      await file.sync();
      if (created) await this.#ops.syncDir(dirname(path));
    } finally {
      await file.close();
    }
  }
  async #repairGenericStream(path: string): Promise<void> {
    let file: StoreFile;
    try {
      file = await this.#ops.open(
        path,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (noExist(error)) return;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0)
        throw fail("journal is not regular");
      const chunk = Buffer.alloc(Math.min(STREAM_READ_CHUNK_BYTES, stat.size));
      let parts: Buffer[] = [];
      let pendingBytes = 0;
      let offset = 0;
      let validEnd = 0;
      const append = (part: Uint8Array) => {
        if (part.byteLength === 0) return;
        if (part.byteLength > MAX_STREAM_LINE_BYTES - pendingBytes)
          throw fail("state stream line exceeds the byte limit");
        parts.push(Buffer.from(part));
        pendingBytes += part.byteLength;
      };
      const parseLine = () => {
        if (pendingBytes === 0) throw fail("empty journal record");
        const line = Buffer.concat(parts, pendingBytes);
        JSON.parse(fatalUtf8.decode(line));
        parts = [];
        pendingBytes = 0;
      };
      while (offset < stat.size) {
        const readBytes = Math.min(chunk.byteLength, stat.size - offset);
        let filled = 0;
        while (filled < readBytes) {
          const read = await file.read(
            chunk,
            filled,
            readBytes - filled,
            offset + filled,
          );
          if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead <= 0)
            throw fail("short journal read");
          filled += read.bytesRead;
        }
        let start = 0;
        let newline = chunk.indexOf(0x0a, start);
        while (newline !== -1 && newline < readBytes) {
          append(chunk.subarray(start, newline));
          try {
            parseLine();
          } catch (error) {
            throw error instanceof AwslError
              ? error
              : fail("malformed journal record", error);
          }
          validEnd = offset + newline + 1;
          start = newline + 1;
          newline = chunk.indexOf(0x0a, start);
        }
        append(chunk.subarray(start, readBytes));
        offset += readBytes;
      }
      if (pendingBytes > 0) {
        try {
          parseLine();
        } catch (error) {
          if (
            error instanceof AwslError &&
            error.message === "state stream line exceeds the byte limit"
          )
            throw error;
          await file.truncate(validEnd);
          await file.sync();
          return;
        }
        await fullWriteAt(file, bytes("\n"), stat.size);
        await file.sync();
      }
    } finally {
      await file.close();
    }
  }
  async #append(
    record:
      | Omit<JournalAttemptRecordV1, "recordSeq" | "recordedAt">
      | Omit<JournalCallRecordV1, "recordSeq" | "recordedAt">,
  ): Promise<DurableJournalRecord> {
    if (this.#releaseStarted) throw fail("store lock release has started");
    return this.#serialized(async () => {
      this.#requireLock();
      const journal = await this.#openJournalForAppend();
      try {
        const assigned = {
          ...record,
          recordSeq: journal.loaded.records.length,
          recordedAt: this.#now().toISOString(),
        };
        const strictAssigned = validateJournalRecord(assigned, this.#runId);
        const canonical = canonicalJson(strictAssigned);
        const snapshot = validateJournalRecord(
          JSON.parse(canonical),
          this.#runId,
        );
        const encoded = bytes(`${canonical}\n`);
        validateJournalRecords([...journal.loaded.records, snapshot]);
        projectedJournalBytes({
          statSize: journal.stat?.size ?? 0,
          validEndOffset: journal.loaded.validEndOffset,
          tailKind: journal.loaded.tailKind,
          appendBytes: encoded.byteLength,
        });
        if (snapshot.kind === "attempt")
          await this.#consumeSourceBinding(snapshot);
        await this.#repairHeldJournalTail(
          journal.file,
          journal.stat,
          journal.loaded,
        );
        await this.#appendBytes(this.paths.journal, encoded, MAX_JOURNAL_BYTES);
        this.#nextRecordSeq = journal.loaded.records.length + 1;
        return { record: snapshot, durable: true };
      } finally {
        await journal.file?.close();
      }
    });
  }
  #bindingKey(attemptId: string, attemptSeq: number): string {
    return `${attemptSeq}:${attemptId}`;
  }
  async #writeImmutable(path: string, content: Buffer): Promise<void> {
    await immutableWrite(this.#ops, path, content, async () => {
      const verified = await this.#readVerified(path);
      if (!verified.equals(content))
        throw fail("immutable state file already differs");
    });
  }
  async #verifySourceBinding(
    record: Omit<JournalAttemptRecordV1, "recordSeq" | "recordedAt">,
  ): Promise<SourceSnapshot> {
    const path = join(
      this.paths.scripts,
      `${record.attemptSeq}-${record.attemptId}-${record.sourceSha256}.js`,
    );
    const manifestPath = join(
      this.paths.scripts,
      `${record.attemptSeq}-${record.attemptId}.manifest.json`,
    );
    let manifest: unknown;
    try {
      manifest = JSON.parse(
        (await this.#readVerified(manifestPath)).toString("utf8"),
      );
    } catch (error) {
      throw error instanceof AwslError
        ? error
        : fail("could not read source manifest", error);
    }
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      Array.isArray(manifest) ||
      (manifest as SourceSnapshot).path !== path ||
      (manifest as SourceSnapshot).manifestPath !== manifestPath ||
      (manifest as SourceSnapshot).runId !== record.runId ||
      (manifest as SourceSnapshot).attemptId !== record.attemptId ||
      (manifest as SourceSnapshot).attemptSeq !== record.attemptSeq ||
      (manifest as SourceSnapshot).sourcePath !== record.sourcePath ||
      (manifest as SourceSnapshot).sha256 !== record.sourceSha256
    )
      throw fail("source manifest does not match attempt");
    const source = await this.#readVerified(path);
    if (
      createHash("sha256").update(source).digest("hex") !== record.sourceSha256
    )
      throw fail("source snapshot hash does not match manifest");
    return manifest as SourceSnapshot;
  }
  async #consumeSourceBinding(
    record: Omit<JournalAttemptRecordV1, "recordSeq" | "recordedAt">,
  ): Promise<void> {
    const key = this.#bindingKey(record.attemptId, record.attemptSeq);
    const binding = await this.#verifySourceBinding(record);
    if (
      binding === undefined ||
      binding.runId !== record.runId ||
      binding.attemptId !== record.attemptId ||
      binding.attemptSeq !== record.attemptSeq ||
      binding.sourcePath !== record.sourcePath ||
      binding.sha256 !== record.sourceSha256
    )
      throw fail("attempt has no matching durable source snapshot");
    this.#sourceBindings.delete(key);
  }
  beginAttempt(
    record: Omit<JournalAttemptRecordV1, "recordSeq" | "recordedAt">,
  ): Promise<DurableJournalRecord> {
    return this.#append(record);
  }
  appendCall(
    record: Omit<JournalCallRecordV1, "recordSeq" | "recordedAt">,
  ): Promise<DurableJournalRecord> {
    return this.#append(record);
  }
  async loadJournal(): Promise<readonly JournalRecordV1[]> {
    const loaded = readJournalJsonlBytes(
      await this.#readVerified(this.paths.journal),
      this.#runId,
    );
    return loaded.records;
  }
  async loadEvents(): Promise<readonly AwslEvent[]> {
    try {
      return parseEventStream(
        await this.#readVerified(this.paths.events),
        this.#runId,
      );
    } catch (error) {
      if (noExist(error)) return Object.freeze([]);
      throw error;
    }
  }
  async readRun(): Promise<RunSnapshot> {
    return (await this.#readJsonSnapshot(
      this.paths.run,
      "run snapshot",
    )) as RunSnapshot;
  }
  async readResult(): Promise<RunResultSnapshot | undefined> {
    try {
      return (await this.#readJsonSnapshot(
        this.paths.result,
        "result snapshot",
      )) as RunResultSnapshot;
    } catch (error) {
      if (noExist(error)) return undefined;
      throw error;
    }
  }
  readLockOwner(): Promise<StoredLockOwner> {
    return this.#readLockFile();
  }
  async removeLockIfMatches(expected: StoredLockOwner): Promise<boolean> {
    if (this.#lockHeld || this.#lockIndeterminate)
      throw fail("cannot repair a lock held by this store");
    const captured = capturedStoredLockOwner(expected);
    let current: StoredLockOwner;
    try {
      current = await this.#readLockFile();
    } catch (error) {
      if (noExist(error)) return false;
      throw error;
    }
    if (!sameStoredLock(captured, current)) return false;
    const confirmed = await this.#readLockFile();
    if (!sameStoredLock(captured, confirmed)) return false;
    const path = await this.#ops.lstat(this.paths.lock);
    if (
      path.isSymbolicLink() ||
      path.dev !== captured.fileIdentity.dev ||
      path.ino !== captured.fileIdentity.ino
    )
      return false;
    await this.#ops.unlink(this.paths.lock);
    await this.#ops.syncDir(this.paths.runDir);
    return true;
  }
  async writeRun(snapshot: RunSnapshot): Promise<void> {
    if (this.#releaseStarted) throw fail("store lock release has started");
    await this.#serialized(async () => {
      this.#requireLock();
      await atomicWrite(
        this.#ops,
        this.paths.run,
        boundedBytes(canonicalJson(snapshot), MAX_STATE_BYTES),
      );
    });
  }
  async writeResult(snapshot: RunResultSnapshot): Promise<void> {
    if (this.#releaseStarted) throw fail("store lock release has started");
    await this.#serialized(async () => {
      this.#requireLock();
      await atomicWrite(
        this.#ops,
        this.paths.result,
        boundedBytes(canonicalJson(snapshot), MAX_STATE_BYTES),
      );
    });
  }
  async writeSourceSnapshot(
    input: SourceSnapshotInput,
  ): Promise<SourceSnapshot> {
    if (this.#releaseStarted) throw fail("store lock release has started");
    return this.#serialized(async () => {
      this.#requireLock();
      if (
        input.runId !== this.#runId ||
        !token.test(input.attemptId) ||
        !Number.isSafeInteger(input.attemptSeq) ||
        input.attemptSeq < 0 ||
        typeof input.sourcePath !== "string" ||
        input.sourcePath.length === 0 ||
        input.sourcePath.includes("\0") ||
        !isAbsolute(input.sourcePath) ||
        resolve(input.sourcePath) !== input.sourcePath
      )
        throw fail("invalid source snapshot identity");
      const bindingKey = this.#bindingKey(input.attemptId, input.attemptSeq);
      if (this.#sourceBindings.has(bindingKey))
        throw fail("source snapshot already bound to attempt");
      const sha256 = createHash("sha256")
        .update(input.source, "utf8")
        .digest("hex");
      const path = join(
        this.paths.scripts,
        `${input.attemptSeq}-${input.attemptId}-${sha256}.js`,
      );
      await this.#writeImmutable(path, bytes(input.source));
      const manifestPath = join(
        this.paths.scripts,
        `${input.attemptSeq}-${input.attemptId}.manifest.json`,
      );
      const snapshot: SourceSnapshot = {
        path,
        manifestPath,
        sha256,
        sourcePath: input.sourcePath,
        runId: input.runId,
        attemptId: input.attemptId,
        attemptSeq: input.attemptSeq,
      };
      await this.#writeImmutable(manifestPath, bytes(canonicalJson(snapshot)));
      this.#sourceBindings.set(bindingKey, snapshot);
      return snapshot;
    });
  }
  async appendEvent(event: AwslEvent): Promise<void> {
    if (this.#releaseStarted) throw fail("store lock release has started");
    await this.#serialized(async () => {
      this.#requireLock();
      await this.#appendBytes(
        this.paths.events,
        boundedStreamLine(canonicalJson(redactJson(event))),
      );
    });
  }
  rawEventSink(
    provider: ProviderId,
  ): undefined | ((event: unknown) => Promise<void>) {
    if (!this.#rawCapture) return undefined;
    if (provider !== "codex" && provider !== "claude")
      throw fail("invalid raw provider");
    return async (event) =>
      this.#releaseStarted
        ? Promise.reject(fail("store lock release has started"))
        : this.#serialized(async () => {
            this.#requireLock();
            await this.#appendBytes(
              join(this.paths.providers, `${provider}.jsonl`),
              boundedStreamLine(canonicalJson(redactJson(event))),
            );
          });
  }
  async acquireRunLock(owner: LockOwner): Promise<RunLock> {
    if (this.#lockHeld || this.#lockIndeterminate)
      throw fail("store already has an active or indeterminate lock");
    const lockOwner = validatedLockOwner(owner, this.#now);
    let file: StoreFile;
    try {
      file = await this.#ops.open(
        this.paths.lock,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw fail("run lock already exists", error);
      throw fail("could not create run lock", error);
    }
    const contents = lockOwner.contents;
    let held: Awaited<ReturnType<StoreFile["stat"]>>;
    try {
      await fullWrite(file, contents);
      await file.sync();
      await this.#ops.syncDir(this.paths.runDir);
      held = await file.stat();
      if (!held.isFile() || (held.mode & 0o777) !== 0o600)
        throw fail("run lock is not a private regular file");
    } catch (error) {
      // A failed acquire only removes a lock after proving the held fd and path
      // still name our nonce.  A partial owner record deliberately fails closed.
      try {
        const held = await file.stat();
        const path = await this.#ops.lstat(this.paths.lock);
        if (
          held.isFile() &&
          !path.isSymbolicLink() &&
          held.dev === path.dev &&
          held.ino === path.ino
        ) {
          const buffer = Buffer.alloc(held.size);
          let offset = 0;
          while (offset < buffer.length) {
            const read = await file.read(
              buffer,
              offset,
              buffer.length - offset,
              offset,
            );
            if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead <= 0)
              throw fail("short run lock read");
            offset += read.bytesRead;
          }
          const parsed: unknown = JSON.parse(buffer.toString("utf8"));
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as { nonce?: unknown }).nonce === lockOwner.nonce
          ) {
            await this.#ops.unlink(this.paths.lock);
            await this.#ops.syncDir(this.paths.runDir);
          }
        }
      } catch {}
      try {
        await file.close();
      } catch {}
      throw fail("could not acquire run lock", error);
    }
    let released = false;
    let releasePromise: Promise<void> | undefined;
    this.#lockHeld = true;
    return {
      release: () => {
        if (releasePromise !== undefined) return releasePromise;
        this.#releaseStarted = true;
        releasePromise = this.#serialized(async () => {
          if (released) return;
          let unlinked = false;
          try {
            const path = await this.#ops.lstat(this.paths.lock);
            if (
              path.isSymbolicLink() ||
              path.dev !== held.dev ||
              path.ino !== held.ino
            )
              throw fail("run lock identity changed");
            let body: string;
            try {
              const current = await file.stat();
              if (
                !current.isFile() ||
                current.dev !== held.dev ||
                current.ino !== held.ino
              )
                throw fail("held run lock identity changed");
              const buffer = Buffer.alloc(current.size);
              let offset = 0;
              while (offset < buffer.length) {
                const read = await file.read(
                  buffer,
                  offset,
                  buffer.length - offset,
                  offset,
                );
                if (
                  !Number.isSafeInteger(read.bytesRead) ||
                  read.bytesRead <= 0
                )
                  throw fail("short run lock read");
                offset += read.bytesRead;
              }
              body = buffer.toString("utf8");
            } catch (error) {
              throw fail("could not verify run lock", error);
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(body);
            } catch (error) {
              throw fail("invalid run lock", error);
            }
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              (parsed as { nonce?: unknown }).nonce !== lockOwner.nonce
            )
              throw fail("run lock nonce changed");
            await this.#ops.unlink(this.paths.lock);
            unlinked = true;
            await this.#ops.syncDir(this.paths.runDir);
          } catch (error) {
            if (unlinked) {
              this.#lockIndeterminate = true;
              throw fail("run lock release is indeterminate", error);
            }
            throw error;
          } finally {
            await file.close();
          }
          released = true;
          this.#lockHeld = false;
        }, true);
        return releasePromise;
      },
    };
  }
}
