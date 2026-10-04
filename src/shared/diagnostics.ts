import { z } from 'zod';
import { McpError } from './errors.js';

export interface ValidationIssue { field: string; message: string }

export function requiredSchemaFields(shape: z.ZodRawShape): string[] {
  return Object.entries(shape).filter(([, schema]) => !(schema as z.ZodType).safeParse(undefined).success).map(([key]) => key);
}

export function schemaGuidance(shape: z.ZodRawShape): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(shape).map(([key, value]) => {
    let schema = value as z.ZodType;
    while (!schema.description && (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodArray)) schema = schema.unwrap() as z.ZodType;
    return [key, schema.description];
  }));
}

/** Only construct with source-controlled field names and guidance, never input values. */
export class ValidationError extends McpError {
  constructor(code: 'CONFIG_INVALID' | 'INVALID_ARGUMENT', public readonly issues: ValidationIssue[]) {
    super(code, issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '));
  }
}

export function invalidArgument(field: string, message: string): ValidationError {
  return new ValidationError('INVALID_ARGUMENT', [{ field, message }]);
}

/** Zod messages and unknown keys can contain user data; build guidance from schema metadata. */
export function validationError(
  error: z.ZodError, fields: Record<string, string | undefined>, code: 'CONFIG_INVALID' | 'INVALID_ARGUMENT' = 'INVALID_ARGUMENT'
): ValidationError {
  const issues: ValidationIssue[] = [];
  for (const issue of error.issues.slice(0, 8)) {
    const candidate = issue.path.filter((part) => typeof part === 'string').join('.');
    const field = Object.hasOwn(fields, candidate) ? candidate : code === 'CONFIG_INVALID' ? 'configuration' : 'arguments';
    let message = fields[field] ?? 'Provide a value matching the documented format.';
    if (issue.code === 'unrecognized_keys') message = 'Remove unknown fields; use the documented field names.';
    else if (issue.code === 'invalid_type') message = `Expected ${issue.expected}.`;
    else if (issue.code === 'too_small') message = `Must have a minimum of ${issue.minimum}${issue.inclusive ? ' (inclusive)' : ' (exclusive)'}.`;
    else if (issue.code === 'too_big') message = `Must have a maximum of ${issue.maximum}${issue.inclusive ? ' (inclusive)' : ' (exclusive)'}.`;
    else if (issue.code === 'invalid_value') message = `Allowed values: ${issue.values.join(', ')}.`;
    if (!issues.some((entry) => entry.field === field && entry.message === message)) issues.push({ field, message });
  }
  return new ValidationError(code, issues);
}

export function recoveryAction(code: string): string | undefined {
  const actions: Record<string, string> = {
    PAIRING_REQUIRED: 'Open P2P Automation, request a fresh pairing code, and run p2p-tools-android pair in a local Termux terminal. Never enter secrets in chat.',
    ANDROID_BACKEND_UNAVAILABLE: 'Open P2P Automation and enable automation. Check setup status before retrying a fetch with the same request key.',
    ANDROID_OPERATION_REFUSED: 'Inspect p2p_setup_status and the existing native job status before resubmitting. Enter account credentials only in the phone app.',
    INTEGRATION_BUSY: 'Wait for this integration\'s active requests to finish; other integrations remain available.',
    INTEGRATION_TIMEOUT: 'Inspect service state before retrying a mutation. Use supplied search or batch identifiers to reconcile asynchronous work.',
    INTEGRATION_AUTH_FAILED: 'Review this integration\'s credentials and API permissions, then rerun doctor.',
    INTEGRATION_REQUEST_FAILED: 'Inspect this service and any mutation outcome before retrying; no automatic mutation retry was performed.',
    INTEGRATION_INVALID_RESPONSE: 'Check the documented service API version and inspect state before retrying a mutation.',
    INTEGRATION_RESPONSE_TOO_LARGE: 'Narrow the request or deliberately adjust this integration\'s byte limit. Inspect state before retrying a mutation.',
    INTEGRATION_UNSUPPORTED_VERSION: 'Use a service version in the adapter\'s documented compatibility range.',
    INTEGRATION_SELECTION_EXPIRED: 'Refresh the search results and select current file IDs.',
    INVALID_ARGUMENT: 'Correct the listed fields and retry; CLI users can run command help with --help.',
    CONFIG_INVALID: 'Correct the configuration or environment override, then run p2p-tools doctor.',
    CONFIG_NOT_FOUND: 'Set P2P_TOOLS_CONFIG to an existing readable YAML file, or unset it to use defaults and environment overrides.',
    CONFIG_UNREADABLE: 'Check that P2P_TOOLS_CONFIG refers to a readable YAML file.',
    JACKETT_AUTH_FAILED: 'Review the Jackett credentials in configuration, then run p2p-tools doctor.',
    JACKETT_UNREACHABLE: 'Check that Jackett is running and its configured base URL is reachable from this process.',
    JACKETT_REQUEST_FAILED: 'Check Jackett service health and configuration, then run p2p-tools doctor.',
    JACKETT_ADMIN_API_UNAVAILABLE: 'Check Jackett admin API access; capability access alone does not verify configured indexers.',
    TORZNAB_PARSE_ERROR: 'Check the configured Jackett endpoint and its Torznab response format.',
    QBIT_LOGIN_FAILED: 'Review the qBittorrent Web UI credentials in configuration, then run p2p-tools doctor.',
    QBIT_UNREACHABLE: 'Check qBittorrent Web UI reachability. Inspect torrent state before retrying any mutation.',
    QBIT_REQUEST_FAILED: 'Check qBittorrent service health and inspect torrent state before retrying any mutation.',
    TORRENT_NOT_FOUND: 'List torrents to obtain a current hash, then retry with that hash.',
    NETWORK_GUARD_BLOCKED: 'Run p2p-tools doctor to inspect the configured guard and VPN status.',
    VPN_UNSUPPORTED: 'Host status inspection requires the supported Linux NordVPN CLI; verify your external VPN boundary separately.',
    VPN_COMMAND_FAILED: 'Check the configured NordVPN executable and inspect VPN state before retrying.',
    VPN_NOT_ACTIVE: 'Connect your VPN through its supported interface, then check status again.',
    VPN_STATUS_UNKNOWN: 'Wait for the VPN transition to finish, then check status again.',
    VPN_STATE_UNCONFIRMED: 'Check VPN status before retrying a connection change.',
    PUBLIC_IP_FAILED: 'Check connectivity and try the public IP lookup again.',
    JEV_KEY_UNAVAILABLE: 'Check that jev.apiKeyFile points to a readable key file.',
    JEV_AUTH_FAILED: 'Check the Jev API key and account access.',
    JEV_TIMEOUT: 'Jev did not respond before the deadline; try ranking a smaller shortlist.',
    JEV_REQUEST_FAILED: 'Check Jev API access and the configured key file, then retry.',
    JEV_INVALID_RESPONSE: 'The Jev API returned an unexpected ranking; no download was started.'
  };
  return actions[code];
}

export function publicDiagnostic(error: McpError, fallback: string) {
  const nextAction = recoveryAction(error.code);
  return {
    code: error.code,
    message: error instanceof ValidationError ? error.message : fallback,
    ...(error instanceof ValidationError ? { issues: error.issues } : {}),
    ...(nextAction ? { next_action: nextAction } : {})
  };
}
