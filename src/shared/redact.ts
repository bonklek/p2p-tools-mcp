const REDACTED = '<redacted>';
const CREDENTIAL_NAME = String.raw`(?:password|passwd|passphrase|token|secret|api[-_.]?key|access[-_.]?key(?:[-_.]?id)?|access[-_.]?token|refresh[-_.]?token|client[-_.]?secret|private[-_.]?key|signing[-_.]?key|authorization|auth|cookie|sid|session)`;
const CREDENTIAL_IDENTIFIER = String.raw`[A-Za-z0-9_.-]{0,128}(?:x[-_])?${CREDENTIAL_NAME}`;
const CREDENTIAL_KEY = /(?:password|passwd|passphrase|token|secret|apikey|accesskey(?:id)?|accesstoken|refreshtoken|clientsecret|privatekey|signingkey|authorization|auth|cookie|sid|session)$/i;
const PATH_KEY = /(?:path|file|filename|folder|directory|dir|cwd|workingdirectory|command|executable|savepath|configpath|downloadsdirectory|downloaddirectory|targetfile)$/i;
const CREDENTIAL_PARAM = new RegExp(`\\b(${CREDENTIAL_IDENTIFIER})\\s*=\\s*([^\\s&]+)`, 'gi');
const QUOTED_CREDENTIAL = new RegExp(`(["']?${CREDENTIAL_IDENTIFIER}["']?\\s*(?:=|:)\\s*)(["'])([\\s\\S]*?)\\2`, 'gi');
const QUOTED_CREDENTIAL_FLAG = new RegExp(`(--${CREDENTIAL_IDENTIFIER}(?:=|\\s+))(["'])([\\s\\S]*?)\\2`, 'gi');
const LINE_CREDENTIAL = new RegExp(`(^|[\\r\\n])([ \\t]*${CREDENTIAL_IDENTIFIER}[ \\t]*(?:=|:)[ \\t]*)([^\\r\\n&]+)`, 'gim');
const INLINE_CREDENTIAL = new RegExp(`(\\b${CREDENTIAL_IDENTIFIER}[ \\t]*(?:=|:)[ \\t]*)([^\\r\\n&]+)`, 'gi');
const ENCODED_SEPARATOR = String.raw`(?:[-_.]|%2[dD]|%5[fF]|%2[eE])`;
const ENCODED_CREDENTIAL_PARAM = new RegExp(
  String.raw`\b(?:[a-z0-9]+${ENCODED_SEPARATOR})*(?:x${ENCODED_SEPARATOR})?(?:password|passwd|passphrase|token|secret|api${ENCODED_SEPARATOR}?key|access${ENCODED_SEPARATOR}?key(?:${ENCODED_SEPARATOR}?id)?|access${ENCODED_SEPARATOR}?token|refresh${ENCODED_SEPARATOR}?token|client${ENCODED_SEPARATOR}?secret|private${ENCODED_SEPARATOR}?key|signing${ENCODED_SEPARATOR}?key|authorization|auth|cookie|sid|session)(?:%3[dD]|=)(?:%22|%27)?[^\s&]+`,
  'gi'
);
const CREDENTIAL_COLON = new RegExp(`(["']?${CREDENTIAL_IDENTIFIER}["']?\\s*:\\s*)(["']?)([^\\s,}\\]\\r\\n<]+)\\2`, 'gi');
const CREDENTIAL_XML = new RegExp(`(<(${CREDENTIAL_IDENTIFIER})>)[\\s\\S]*?(<\\/\\2>)`, 'gi');
const CREDENTIAL_FLAG = new RegExp(`(--${CREDENTIAL_IDENTIFIER}(?:=|\\s+))([^\\s]+)`, 'gi');
const URL_USERINFO = /\b(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const CONNECTION_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const FILE_URI = /\bfile:\/\/[^\r\n,;"'<>]+/gi;
const GENERIC_AUTH = /\b((?:Bearer|Basic)\s+)([A-Za-z0-9+/_=.-]+)/gi;
const SPACE_CREDENTIAL = new RegExp(`(\\b${CREDENTIAL_IDENTIFIER})[ \\t]+([^\\r\\n]+)`, 'gim');
const PEM_PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const KNOWN_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const USER_PATH = /(?:\b[A-Za-z]:[\\/][^\r\n,;"'<>|]+|\\\\[^\r\n,;"'<>|]+|\/(?:Users|home)\/[^\r\n,;"'<>]+)/g;
const POSIX_PATH = /(?<![:/\w])\/[^\r\n,;"'<>]+/g;
const RELATIVE_PATH = /(^|[\s"'(])(?:\.{1,2}[\\/](?:[^\\/\s:"'<>]+[\\/])*[^\r\n,;"'<>]+|(?:[^\\/\s:"'<>]+[\\/])+[^\\/\s:"'<>]+\.[A-Za-z0-9]{1,8})/g;

export function redactValue(value: string): string {
  if (value.length > 8_192) return REDACTED;
  const canonical = canonicalizeForDetection(value);
  if (
    canonical !== value
    && (redactText(canonical) !== canonical || /%[0-9a-f]{2}/i.test(canonical))
  ) return REDACTED;
  return redactText(value);
}

function redactText(value: string): string {
  return value
    .replace(PEM_PRIVATE_KEY, REDACTED)
    .replace(/\b(Authorization:\s*(?:Bearer|Basic)\s+)([^\s]+)/gi, `$1${REDACTED}`)
    .replace(GENERIC_AUTH, `$1${REDACTED}`)
    .replace(SPACE_CREDENTIAL, `$1 ${REDACTED}`)
    .replace(QUOTED_CREDENTIAL, `$1${REDACTED}`)
    .replace(QUOTED_CREDENTIAL_FLAG, `$1${REDACTED}`)
    .replace(LINE_CREDENTIAL, `$1$2${REDACTED}`)
    .replace(INLINE_CREDENTIAL, `$1${REDACTED}`)
    .replace(CREDENTIAL_PARAM, (_m, key) => `${key}=${REDACTED}`)
    .replace(ENCODED_CREDENTIAL_PARAM, REDACTED)
    .replace(CREDENTIAL_COLON, (_m, prefix, quote) => `${prefix}${quote}${REDACTED}${quote}`)
    .replace(CREDENTIAL_XML, `$1${REDACTED}$3`)
    .replace(CREDENTIAL_FLAG, `$1${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}:${REDACTED}@`)
    .replace(CONNECTION_USERINFO, `$1${REDACTED}:${REDACTED}@`)
    .replace(FILE_URI, '<redacted-path>')
    .replace(KNOWN_TOKEN, REDACTED)
    .replace(USER_PATH, '<redacted-path>')
    .replace(POSIX_PATH, '<redacted-path>')
    .replace(RELATIVE_PATH, '$1<redacted-path>');
}

function canonicalizeForDetection(value: string): string {
  let canonical = value.replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
  for (let pass = 0; pass < 16 && /%[0-9a-f]{2}/i.test(canonical); pass += 1) {
    const decoded = canonical.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
    if (decoded === canonical) break;
    canonical = decoded;
  }
  return canonical;
}

export function redactConfig<T>(value: T): T {
  return redactObject(value) as T;
}

function redactObject(value: unknown, key = ''): unknown {
  const normalizedKey = normalizeKey(key);
  if (typeof value === 'string') {
    if (CREDENTIAL_KEY.test(normalizedKey)) return REDACTED;
    if (PATH_KEY.test(normalizedKey)) return '<redacted-path>';
    return redactValue(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactObject(item, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const normalizedEntryKey = normalizeKey(entryKey);
      out[entryKey] = CREDENTIAL_KEY.test(normalizedEntryKey)
        ? REDACTED
        : PATH_KEY.test(normalizedEntryKey) && typeof entryValue === 'string'
          ? '<redacted-path>'
          : redactObject(entryValue, entryKey);
    }
    return out;
  }
  return value;
}

function normalizeKey(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}
