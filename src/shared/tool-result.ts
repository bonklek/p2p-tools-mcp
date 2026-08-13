import { McpError } from './errors.js';
import { redactConfig } from './redact.js';

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

export async function structuredResult(
  run: () => Promise<unknown>,
  publicErrorMessage: (code: string) => string
): Promise<ToolResult> {
  try {
    return { ok: true, data: redactConfig(await run()) };
  } catch (error) {
    if (error instanceof McpError) {
      return { ok: false, error: { code: error.code, message: publicErrorMessage(error.code) } };
    }
    return { ok: false, error: { code: 'TOOL_ERROR', message: 'The tool operation failed' } };
  }
}

export function mcpJsonContent(value: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: JSON.parse(JSON.stringify(value)) as Record<string, unknown>,
    ...(value.ok ? {} : { isError: true })
  };
}
