export type AwslErrorCode =
  | "USAGE_ERROR"
  | "CONFIG_ERROR"
  | "COMPATIBILITY_ERROR"
  | "WORKFLOW_ERROR"
  | "PROVIDER_ERROR"
  | "SCHEMA_ERROR"
  | "BUDGET_EXCEEDED"
  | "CANCELLED"
  | "PERSISTENCE_ERROR"
  | "WORKTREE_ERROR";

export interface AwslErrorOptions {
  recoverable: boolean;
  runId?: string;
  callId?: string;
  phase?: string;
  provider?: string;
  cause?: unknown;
}

export interface AwslErrorJSON {
  name: "AwslError";
  code: AwslErrorCode;
  message: string;
  recoverable: boolean;
  runId?: string;
  callId?: string;
  phase?: string;
  provider?: string;
}

export class AwslError extends Error {
  readonly code: AwslErrorCode;
  readonly recoverable: boolean;
  readonly runId?: string;
  readonly callId?: string;
  readonly phase?: string;
  readonly provider?: string;

  constructor(code: AwslErrorCode, message: string, options: AwslErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "AwslError";
    this.code = code;
    this.recoverable = options.recoverable;
    this.runId = options.runId;
    this.callId = options.callId;
    this.phase = options.phase;
    this.provider = options.provider;
  }

  toJSON(): AwslErrorJSON {
    return {
      name: "AwslError",
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      ...(this.runId === undefined ? {} : { runId: this.runId }),
      ...(this.callId === undefined ? {} : { callId: this.callId }),
      ...(this.phase === undefined ? {} : { phase: this.phase }),
      ...(this.provider === undefined ? {} : { provider: this.provider }),
    };
  }
}
