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
p2p-tools jackett test
```

PowerShell:

```powershell
$env:P2P_TOOLS_CONFIG = '<private-config-file>'
p2p-tools jackett test
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

Known operation failures use the same fixed error codes and messages as MCP tools:

```json
{
  "ok": false,
  "error": {
    "code": "NETWORK_GUARD_BLOCKED",
    "message": "Network guard blocked this operation"
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

The original `vpn-mcp` and `torrent-mcp` binaries remain available and keep their existing MCP interfaces.
