export const AWSL_EVENT_VERSION = 1 as const;

export interface AwslEvent<TData = unknown> {
  version: typeof AWSL_EVENT_VERSION;
  type: string;
  timestamp: string;
  runId: string;
  data: TData;
}

export function createEvent<TData>(
  type: string,
  runId: string,
  data: TData,
): AwslEvent<TData> {
  return {
    version: AWSL_EVENT_VERSION,
    type,
    timestamp: new Date().toISOString(),
    runId,
    data,
  };
}
