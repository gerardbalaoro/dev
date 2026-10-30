import type { Extension } from "@/config/types";
import type { ProcessResult } from "@/process/run";
import type { Result, Running } from "@/session/launch";

export type Request =
  | { type: "start"; cwd: string; config: Extension }
  | { type: "exec"; id: number; command: string[] }
  | { type: "stop" };

export interface Failure {
  message: string;
  errors?: Failure[];
}

export type Response =
  | { type: "ready"; session: Pick<Running, "workspace" | "env" | "endpoints"> }
  | { type: "exit"; result: Result }
  | { type: "error"; error: Failure }
  | { type: "result"; id: number; result: ProcessResult }
  | { type: "failure"; id: number; error: Failure };

export function failure(error: Error): Failure {
  const result: Failure = { message: error.message };

  if (error instanceof AggregateError) {
    result.errors = error.errors.map(failure);
  }

  return result;
}

export function restore(error: Failure): Error {
  return error.errors
    ? new AggregateError(error.errors.map(restore), error.message)
    : new Error(error.message);
}
