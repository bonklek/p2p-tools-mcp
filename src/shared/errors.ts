import { redactValue } from './redact.js';

export class McpError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function toErrorMessage(error: unknown): string {
  return redactValue(error instanceof Error ? error.message : String(error));
}
