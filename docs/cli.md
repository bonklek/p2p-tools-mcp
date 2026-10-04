# p2p-tools CLI

The `p2p-tools` command ships in the same npm package as `vpn-mcp` and `torrent-mcp`. It loads the same YAML configuration and environment overrides, calls the same validated operation handlers, applies the same torrent network guard, and returns the same redacted JSON envelopes.

## Install and run

From a source checkout:

```sh
npm ci
npm run build
node dist/p2p-tools.js --help
```

Installing a release package exposes all three commands:

```text
p2p-tools
vpn-mcp
torrent-mcp
```

Set the configuration path before running service-backed commands.

macOS/Linux:

```sh
export P2P_TOOLS_CONFIG=<private-config-file>
p2p-tools doctor
```

PowerShell:

```powershell
$env:P2P_TOOLS_CONFIG = '<private-config-file>'
p2p-tools doctor
```

The CLI supports the same environment overrides documented in the [User Guide](user-guide.md#environment-overrides). When `P2P_TOOLS_CONFIG` is unset, loopback service defaults are used.

## Output and exit codes

Every operation writes one JSON envelope to stdout:

```json
{
  "ok": true,
  "data": {}
}
```

Known operation failures use stable error codes, safe messages, and recovery steps:

```json
{
  "ok": false,
  "error": {
    "code": "NETWORK_GUARD_BLOCKED",
    "message": "Network guard blocked this operation",
    "next_action": "Run p2p-tools doctor to inspect the configured guard and VPN status."
  }
}
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | The command completed successfully. |
| `1` | The requested operation failed. |
| `2` | Invocation or configuration was invalid. |

Add `--compact` for one-line JSON.

Parser/configuration errors are written to stderr. Shared handler results, including `INVALID_ARGUMENT` (exit 2), are written to stdout. `--help` and `--version` print text. For command-specific options and required JSON fields, run `p2p-tools qbit add-magnet --help`; help does not load configuration or contact services.

Validation errors include `issues`, a list of known field names and constraints, plus `next_action`. For example, `qbit pause --hash invalid` explains that `hashes` needs 40- or 64-character hexadecimal hashes. Supplied values and unknown field names are not repeated in shared-handler diagnostics. Semantic errors explain relationships such as using `tvsearch` with `season`. Service failures give recovery guidance; after an uncertain mutation, inspect torrent state before retrying.

MCP uses the same operation handlers. The SDK may reject schema-invalid calls before those handlers run, returning its native validation error instead of this JSON envelope. Consult the advertised tool schema in that case.

## Setup diagnostics

Optional services and their CLI commands are documented in the [basket guide](basket.md). Start with `p2p-tools basket integrations`; it lists configuration states without contacting services. `doctor` includes optional probes when an integrations section exists; optional failures degrade the report to `attention_needed` without blocking other integrations.

```sh
p2p-tools doctor
p2p-tools doctor --compact
p2p-tools doctor --help
```

Doctor validates configuration, checks Jackett Torznab/admin API access and configured indexers, reads the qBittorrent version through its Web UI, and inspects the host VPN guard when operations are guarded. It does not search indexers, add or change torrents, connect or disconnect the VPN, or test public IP routing. Service authentication may establish an ordinary API login. Independent probes continue after failures and use the configured request timeouts; multi-request probes can take longer than one timeout.

Each check contains `name`, `status`, `message`, and, when useful, `next_action`. Check statuses are `passed`, `warning`, `failed`, or `not_checked`. The report always marks traffic isolation `not_checked`: recognized service versions and a connected host VPN do not establish kill-switch or container isolation behavior.

| Report `data.status` | Meaning | CLI exit |
| --- | --- | --- |
| `checks_passed` | All performed checks passed; traffic isolation remains unverified. | `0` |
| `attention_needed` | Warnings only, such as no indexers, an unrecognized version, or no operations protected by the host guard. | `0` |
| `blocked` | At least one service or host-guard check failed. | `1` |

`ok: true` means doctor produced its report, including a `blocked` report. Scripts must inspect `data.status` and the individual checks; MCP returns the same report without marking the reporting operation as an error. Invalid configuration returns `ok: false` on stderr with exit `2`, before any service probes. Unexpected configuration errors retain `CONFIG_ERROR`; recognized cases use `CONFIG_INVALID`, `CONFIG_NOT_FOUND`, or `CONFIG_UNREADABLE` with safe recovery steps.

On Windows and macOS, the host NordVPN status adapter is unsupported. An enabled guard covering operations therefore produces a failed check. For an intentional external VPN boundary, doctor reports the disabled host guard as a warning and still cannot verify that boundary. Follow the [deployment guide](../deploy/vpn-qbit/README.md) for that separate verification.

## VPN commands

```sh
p2p-tools vpn status
p2p-tools vpn connect
p2p-tools vpn connect --country Canada
p2p-tools vpn disconnect
p2p-tools vpn public-ip
p2p-tools vpn require-active
```

VPN platform support is the same as the MCP adapter. See the [platform table](../README.md#platform-support).

Connect/disconnect can report command acceptance with `connected: null` and `state_verified: false` when status is unavailable. Only `state_verified: true` establishes the returned state. A recognized opposite state returns `VPN_STATE_UNCONFIRMED`; see the [lifecycle result contract](user-guide.md#vpn_connect).

## Jackett commands

Test the connection and list indexers:

```sh
p2p-tools jackett test
p2p-tools jackett indexers
```

Search:

```sh
p2p-tools jackett search --query "example query" --indexer all --limit 25
p2p-tools jackett search --type music --category 3000,3010
p2p-tools jackett search --type tvsearch --season 2 --episode 4
p2p-tools jackett search --type movie --imdb-id tt1234567
```

Read capabilities and resolve a local category alias:

```sh
p2p-tools jackett caps --indexer all
p2p-tools jackett category --query "audio flac"
```

Search flags map directly to the canonical `jackett_search` fields: `--query`, `--indexer`, `--type`, `--category`, `--season`, `--episode`, `--imdb-id`, `--limit`, and `--offset`. Repeat `--category` or provide comma-separated IDs.

## qBittorrent commands

`qbit` is a short alias for `qbittorrent`.

```sh
p2p-tools qbittorrent test
p2p-tools qbit list --filter downloading --sort-by progress --limit 50
p2p-tools qbit get --hash <torrent-hash>
```

Add a magnet or torrent URL through JSON stdin so the complete value is not stored in process arguments. Use the platform-specific forms in [JSON through stdin](#json-through-stdin). Torrent URLs must use HTTP or HTTPS and cannot contain user-info credentials. Add options are `--category`, repeatable `--tag`, `--paused`, and `--skip-checking`. Boolean options accept `--option`, `--option=true`, or `--option=false`. Supply `magnet_uri`, `torrent_url`, and the path-bearing `save_path` only through `--stdin`.

Pause and resume accept one or more hashes:

```sh
p2p-tools qbit pause --hash <first-hash> --hash <second-hash>
p2p-tools qbit resume --hash <first-hash>,<second-hash>
```

Deletion requires `--yes`. Downloaded files remain in place unless `--delete-files` is also supplied.

Each hash must contain 40 or 64 hexadecimal characters. `all` and embedded `|` separators are rejected. Add success means service acceptance, not a completed download; use list/get to check progress. `--paused` is sent in the form recognized by both qBittorrent 4.x and 5.x.

```sh
p2p-tools qbit delete --hash <torrent-hash> --yes
p2p-tools qbit delete --hash <torrent-hash> --delete-files --yes
```

## JSON through stdin

Add `--stdin` to merge one JSON object into the command arguments. Explicit flags take precedence. This is useful for automation and for values that should not be placed in process arguments.

macOS/Linux:

```sh
printf '%s' '{"query":"audio flac"}' | p2p-tools jackett category --stdin
printf '%s' '{"hashes":["<first-hash>","<second-hash>"]}' | p2p-tools qbit pause --stdin
printf '%s' '{"magnet_uri":"magnet:?xt=urn:btih:<info-hash>"}' | p2p-tools qbit add-magnet --stdin --category mcp
```

PowerShell:

```powershell
'{"query":"audio flac"}' | p2p-tools jackett category --stdin
'{"hashes":["<first-hash>","<second-hash>"]}' | p2p-tools qbit pause --stdin
'{"torrent_url":"https://example.invalid/file.torrent"}' | p2p-tools qbit add-url --stdin --paused
```

Unknown JSON fields, invalid option values, and missing required values fail before an operation runs. Deletion still requires `--yes` when arguments come from stdin.

## MCP and CLI parity

The CLI is an additional frontend, not a separate implementation. Both frontends share:

- YAML loading and environment overrides;
- Zod input schemas;
- NordVPN, Jackett, and qBittorrent clients;
- the configured torrent network guard;
- response normalization and recursive redaction;
- fixed public error envelopes.

The original `vpn-mcp` and `torrent-mcp` binaries remain available. See [Validation](validation.md) for deliberate validation and VPN-result compatibility changes in this unreleased working tree.
