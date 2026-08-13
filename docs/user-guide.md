# p2p-tools-mcp User Guide

This guide covers installation, shared configuration, MCP registration, verification, privacy behavior, and troubleshooting for `p2p-tools-mcp` 0.2. The package also includes the [`p2p-tools` CLI](cli.md), which uses the same operation handlers as both MCP servers.

## Architecture

```text
MCP client
  |-- vpn-mcp
  |     `-- supported NordVPN command
  |
  `-- torrent-mcp
        |-- Jackett API
        |-- qBittorrent Web API
        `-- optional host VPN status check
```

The package exposes a second frontend over the same core:

```text
p2p-tools CLI
  |-- VPN operations
  |-- Jackett operations
  `-- qBittorrent operations
```

The servers are intentionally independent:

- `vpn-mcp` owns VPN status, connect, disconnect, public-IP, and require-active operations.
- `torrent-mcp` owns Jackett and qBittorrent operations.
- `torrent-mcp` never connects or disconnects a VPN.
- The optional network guard checks VPN status before selected operations and fails closed when it cannot prove the required state.

## Choose a deployment topology

### Dedicated torrent VPN boundary (recommended)

```text
MCP client and p2p-tools-mcp
             |
             | loopback Web APIs
             v
Jackett + qBittorrent + dedicated VPN network boundary
```

This topology works consistently on Windows, macOS, and Linux. The host-level `network_guard` should be disabled because the service network boundary—not the host CLI—is enforcing VPN routing. The included example uses containers; see [Torrent-side VPN isolation](../deploy/vpn-qbit/README.md).

### Host-wide VPN

Jackett, qBittorrent, and the MCP servers run through a host VPN. The built-in status parser and torrent guard require [NordVPN's supported Linux CLI](https://support.nordvpn.com/hc/en-us/articles/20196094470929-How-to-install-the-NordVPN-app-on-Linux-distributions). Windows can use NordVPN's [documented command switches](https://support.nordvpn.com/hc/en-us/articles/19919384880145-Connect-to-NordVPN-Windows-with-Command-Prompt) but not the status-dependent tools. macOS must manage VPN state through its [native application](https://support.nordvpn.com/hc/en-us/articles/19456281201041-Installing-NordVPN-application-on-macOS) or another external boundary.

Do not enable the built-in guard on a platform where `vpn_status` is unsupported; guarded operations will fail closed.

## Requirements

- Node.js 20 or newer and npm.
- Jackett with at least one configured indexer for search operations.
- qBittorrent with its Web UI enabled for lifecycle operations.
- NordVPN's supported Linux CLI only for the complete built-in VPN/guard workflow.

CI currently covers Node.js 24 on Windows, macOS, and Linux. The package's declared minimum remains Node.js 20.

## Build and test

From a reviewed source checkout:

```sh
npm ci
npm test
npm run check
npm run build
```

The expected build outputs are:

```text
dist/p2p-tools.js
dist/vpn-mcp.js
dist/torrent-mcp.js
```

`npm ci` uses the committed lockfile and is preferred for reproducible setup. Use `npm install` only when intentionally changing dependencies.

## Create a private configuration

Copy `examples/config.yaml` to an untracked location:

```sh
cp examples/config.yaml <private-config-file>
```

Do not commit API keys, passwords, or a populated runtime configuration.

### Optional permission hardening

On a shared host or a host with broad default file permissions, restrict the populated configuration to the account that launches the CLI or MCP server.

macOS/Linux:

```sh
chmod 600 <private-config-file>
```

Windows: use a current-user-only directory or apply a current-user-only ACL. This hardening is optional and is not required by the setup flow.

Minimal same-host configuration:

```yaml
vpn:
  provider: nordvpn
  command: nordvpn

network_guard:
  enabled: true
  requireVpnConnected: true
  guarded_operations:
    - torrent_search
    - torrent_caps
    - torrent_list_indexers
    - torrent_add

jackett:
  baseUrl: http://127.0.0.1:9117
  apiKey: <jackett-api-key>

qbittorrent:
  baseUrl: http://127.0.0.1:8080
  username: <web-ui-username>
  password: <web-ui-password>

timeouts:
  commandMs: 15000
  httpMs: 15000
```

### Configuration reference

| Key | Default | Purpose |
| --- | --- | --- |
| `vpn.provider` | `nordvpn` | VPN adapter; no other provider is currently accepted. |
| `vpn.command` | `nordvpn` | Command invoked by `vpn-mcp` and the host guard. |
| `vpn.defaultCountry` | unset | Used by `vpn_connect` when `country` is omitted. |
| `network_guard.enabled` | `true` | Enables checks for configured operation IDs. |
| `network_guard.requireVpnConnected` | `true` | Requires the status adapter to report connected. |
| `network_guard.guarded_operations` | four discovery/add IDs | Operations that must pass the host guard. |
| `jackett.baseUrl` | `http://127.0.0.1:9117` | Jackett service URL. |
| `jackett.apiKey` | unset | Jackett API key. |
| `qbittorrent.baseUrl` | `http://127.0.0.1:8080` | qBittorrent Web UI URL. |
| `qbittorrent.username` | unset | Web UI username. |
| `qbittorrent.password` | unset | Web UI password. |
| `timeouts.commandMs` | `15000` | VPN command timeout in milliseconds. |
| `timeouts.httpMs` | `15000` | Jackett/qBittorrent/IP-check timeout in milliseconds. |

### Environment overrides

Environment variables override YAML values:

| Variable | Overrides |
| --- | --- |
| `P2P_TOOLS_CONFIG` | Path to the YAML configuration file. |
| `NORDVPN_COMMAND` | `vpn.command` |
| `NORDVPN_DEFAULT_COUNTRY` | `vpn.defaultCountry` |
| `P2P_NETWORK_GUARD_ENABLED` | `network_guard.enabled`; accepts `true`, `false`, `1`, or `0`. |
| `JACKETT_BASE_URL` | `jackett.baseUrl` |
| `JACKETT_API_KEY` | `jackett.apiKey` |
| `QBITTORRENT_BASE_URL` | `qbittorrent.baseUrl` |
| `QBITTORRENT_USERNAME` | `qbittorrent.username` |
| `QBITTORRENT_PASSWORD` | `qbittorrent.password` |
| `P2P_COMMAND_TIMEOUT_MS` | `timeouts.commandMs` |
| `P2P_HTTP_TIMEOUT_MS` | HTTP timeout for both services. |
| `JACKETT_TIMEOUT_MS` | HTTP-timeout fallback. |
| `QBITTORRENT_TIMEOUT_MS` | HTTP-timeout fallback. |

Prefer a private configuration or secret injection from the process supervisor. Environment variables may be visible to same-user process-inspection tools on some systems.

On Windows, configure `vpn.command` as the trusted absolute path of the NordVPN command executable. VPN child processes receive a restricted system environment and do not inherit the caller's `PATH`. The default `nordvpn` command is intended for standard Linux installations.

## Network guard

The guard uses stable internal operation IDs for compatibility. Canonical tools map to these IDs:

| Internal guard ID | Canonical tools |
| --- | --- |
| `torrent_search` | `jackett_search` |
| `torrent_caps` | `jackett_caps` |
| `torrent_list_indexers` | `jackett_list_indexers` |
| `torrent_add` | `qbittorrent_add_magnet`, `qbittorrent_add_torrent_url` |
| `torrent_list` | `qbittorrent_list_torrents` |
| `torrent_get` | `qbittorrent_get_torrent` |
| `torrent_pause` | `qbittorrent_pause_torrent` |
| `torrent_resume` | `qbittorrent_resume_torrent` |
| `torrent_delete` | `qbittorrent_delete_torrent` |

The default guards discovery and add operations. To guard every network/lifecycle operation:

```yaml
network_guard:
  enabled: true
  requireVpnConnected: true
  guarded_operations:
    - torrent_search
    - torrent_caps
    - torrent_list_indexers
    - torrent_add
    - torrent_list
    - torrent_get
    - torrent_pause
    - torrent_resume
    - torrent_delete
```

Local connection tests and `jackett_get_category` are not guard-configurable in 0.2.

If a dedicated container/network boundary already protects Jackett and qBittorrent, set `network_guard.enabled: false`. Do not represent the host guard as active in that topology.

## Register the MCP servers

An MCP client starts the compiled entrypoints and communicates over stdio. Example configuration:

```yaml
mcp_servers:
  vpn:
    command: node
    args:
      - <repo-root>/dist/vpn-mcp.js
    env:
      P2P_TOOLS_CONFIG: <private-config-file>

  torrent:
    command: node
    args:
      - <repo-root>/dist/torrent-mcp.js
    env:
      P2P_TOOLS_CONFIG: <private-config-file>
```

Register only the server you need. Restart the MCP client after editing its configuration. See [Hermes wiring](hermes-config.md) for Hermes-specific timeout fields and expected prefixed names.

The server reserves stdout for MCP protocol data. A directly launched entrypoint may appear idle; this is normal.

## Use the CLI

The npm package installs `p2p-tools` alongside the two MCP binaries. From a source build, run the equivalent entrypoint with `node dist/p2p-tools.js`.

```sh
p2p-tools vpn status
p2p-tools jackett category --query "audio flac"
p2p-tools jackett search --query "example query" --limit 25
p2p-tools qbit list --filter downloading
```

The CLI uses `P2P_TOOLS_CONFIG` and every environment override in this guide. It returns the same structured envelopes, validation errors, network-guard decisions, normalized data, and redaction behavior as MCP. See the [CLI Guide](cli.md) for the complete command reference, JSON stdin, exit codes, and confirmed deletion.

## Response envelope

Every tool returns a JSON envelope as text and structured MCP content.

Success:

```json
{
  "ok": true,
  "data": {}
}
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "NETWORK_GUARD_BLOCKED",
    "message": "Network guard blocked this operation"
  }
}
```

Service responses are normalized and redacted. Do not build clients that depend on undocumented raw Jackett or qBittorrent fields.

## VPN tool reference

### `vpn_status`

Arguments: none. Linux CLI only. Returns a minimized parsed status such as `connected`, country, city, server, technology, and protocol when available.

### `vpn_connect`

```json
{ "country": "United_States" }
```

`country` is optional; `vpn.defaultCountry` is the fallback. Supported on Linux and through the mapped Windows command switches. Not supported on macOS.

### `vpn_disconnect`

Arguments: none. Supported on Linux and through the mapped Windows command switch. Not supported on macOS.

### `vpn_public_ip`

Arguments: none. Contacts the built-in external IP-check service and returns only the current public IP. Calling it intentionally discloses the requester's public IP to that service.

### `vpn_require_active`

Arguments: none. Linux CLI only. Succeeds only when the parsed status reports connected.

## Jackett tool reference

### `jackett_test_connection`

Arguments: none. Validates connectivity and API-key access without using the network guard.

### `jackett_search`

```json
{
  "query": "example query",
  "indexer": "all",
  "search_type": "search",
  "categories": [8000],
  "limit": 25,
  "offset": 0
}
```

All fields are optional at the schema level because some typed Torznab searches rely on IDs. Supported `search_type` values are `search`, `tvsearch`, `movie`, `music`, and `book`.

- `season` and `episode` are valid only with `tvsearch`.
- `imdb_id` must look like `tt1234567` and is valid only with `movie`.
- `limit` is 1–100; `offset` is zero or greater.

Results include normalized title, BTIH-only magnet URI when safe, info hash, sizes, swarm counts, publish date, categories, IMDb ID, indexer, and ratio factors. Raw comments, arbitrary attributes, peer names, and unsafe download URLs are omitted.

### `jackett_caps`

```json
{ "indexer": "all" }
```

Returns normalized search capabilities, categories, tags, and limited server metadata.

### `jackett_list_indexers`

Arguments: none. Lists configured indexers through Jackett's admin API.

### `jackett_get_category`

```json
{ "query": "audio flac" }
```

Resolves a user-facing category or alias to Torznab category IDs locally.

## qBittorrent tool reference

### `qbittorrent_test_connection`

Arguments: none. Validates authentication and returns the service version.

### `qbittorrent_add_magnet`

```json
{
  "magnet_uri": "magnet:?xt=urn:btih:<info-hash>",
  "save_path": "<configured-download-location>",
  "category": "mcp",
  "tags": ["example"],
  "paused": false,
  "skip_checking": false
}
```

`magnet_uri` is required. The other fields are optional. Omit `save_path` to use qBittorrent's configured location.

### `qbittorrent_add_torrent_url`

```json
{
  "torrent_url": "https://example.invalid/file.torrent",
  "category": "mcp",
  "paused": true
}
```

`torrent_url` must be an HTTP or HTTPS URL without embedded user-info credentials. Other options match `qbittorrent_add_magnet`.

### `qbittorrent_list_torrents`

```json
{
  "filter": "downloading",
  "category": "mcp",
  "tag": "example",
  "sort_by": "progress",
  "limit": 50
}
```

Supported filters: `all`, `downloading`, `completed`, `paused`, `active`, `inactive`.

Supported sort fields: `added_on`, `progress`, `dlspeed`, `upspeed`, `eta`, `name`.

`limit` is 1–1000. Results omit local save paths.

### `qbittorrent_get_torrent`

```json
{ "hash": "<torrent-hash>" }
```

Returns a normalized summary plus selected detailed properties. Local filesystem paths are redacted or omitted.

### `qbittorrent_pause_torrent` and `qbittorrent_resume_torrent`

One hash:

```json
{ "hash": "<torrent-hash>" }
```

Multiple hashes:

```json
{ "hashes": ["<first-hash>", "<second-hash>"] }
```

### `qbittorrent_delete_torrent`

```json
{
  "hashes": ["<torrent-hash>"],
  "delete_files": false
}
```

This is destructive. Downloaded files are retained by default. Set `delete_files: true` only after explicit confirmation that data removal is intended.

## Deprecated compatibility aliases

The following aliases exist only for migration during the 0.2 line:

| Deprecated alias | Canonical replacement |
| --- | --- |
| `torrent_search` | `jackett_search` |
| `torrent_caps` | `jackett_caps` |
| `torrent_list_indexers` | `jackett_list_indexers` |
| `torrent_add` | `qbittorrent_add_magnet` or `qbittorrent_add_torrent_url` |
| `torrent_list` | `qbittorrent_list_torrents` |
| `torrent_get` | `qbittorrent_get_torrent` |
| `torrent_pause` | `qbittorrent_pause_torrent` |
| `torrent_resume` | `qbittorrent_resume_torrent` |
| `torrent_delete` | `qbittorrent_delete_torrent` |

Do not use aliases in new MCP registrations, prompts, or automation.

## Verification workflow

After the MCP client restarts:

1. Call `jackett_test_connection`.
2. Call `qbittorrent_test_connection`.
3. If using the Linux host guard, call `vpn_status` and `vpn_require_active`.
4. Call `jackett_get_category` for the intended category.
5. Run a narrow `jackett_search`.
6. Add a known magnet or torrent URL.
7. Confirm it appears with `qbittorrent_list_torrents`.
8. Exercise pause/resume if needed.
9. Remove the test job; leave `delete_files` false unless file removal is intentional.

The connection tests prove credentials and reachability. A search returning no results may still indicate a healthy MCP integration if Jackett has no matching/indexer results.

## Privacy and security model

- Treat the configuration as a secret-bearing file.
- Keep Jackett and qBittorrent on loopback or a protected network; remote plaintext HTTP exposes credentials in transit.
- The MCP layer is not an authentication proxy. Control which users and agents can invoke its tools.
- Success responses are recursively redacted for credential- and path-shaped fields.
- Known failures use fixed public error messages; unexpected exceptions become `TOOL_ERROR`.
- VPN subprocesses receive a reduced environment rather than the caller's full environment.
- `vpn_public_ip` is the only tool designed to contact a public IP-check endpoint directly.
- Tool names and search/add requests may remain visible to the MCP client and its logs. Apply client-side retention controls appropriate to the deployment.
- stdout is reserved for MCP protocol traffic; route diagnostic logging to stderr and never log secrets.

## Troubleshooting

### MCP process starts and appears to do nothing

That is normal for a stdio server. Start it through an MCP client or protocol inspector rather than expecting an interactive prompt.

### Tools do not appear

- Confirm `npm run build` completed.
- Confirm the client points to the correct `dist/*.js` entrypoint.
- Confirm `node` is available in the client's environment.
- Restart the client after configuration changes.
- Inspect the client's stderr/startup log without posting secret-bearing configuration.

### `NETWORK_GUARD_BLOCKED`

- On Linux host-wide VPN deployments, verify the configured NordVPN command and its status output.
- On Windows or macOS, disable the unsupported host guard only after establishing an equivalent external network boundary.
- In the dedicated container topology, confirm the container VPN health and keep the host guard disabled.

### `JACKETT_AUTH_FAILED` or `JACKETT_UNREACHABLE`

- Verify `jackett.baseUrl` from the MCP host.
- Re-copy the API key from Jackett.
- Confirm firewall, TLS, and reverse-proxy settings.
- Use `jackett_test_connection` before debugging search parameters.

### `QBIT_LOGIN_FAILED` or `QBIT_UNREACHABLE`

- Verify the Web UI is enabled and reachable from the MCP host.
- Check the base URL and credentials.
- Review qBittorrent's host-header, reverse-proxy, and authentication settings.
- Use `qbittorrent_test_connection` before lifecycle tools.

### A torrent is accepted but does not transfer

This usually reflects qBittorrent, tracker, peer, routing, or storage state rather than MCP state. Check the qBittorrent UI, category/save-path configuration, tracker status, network binding, and permissions.

### Configuration errors at startup

- Confirm the YAML root is an object.
- Confirm both service URLs are valid absolute URLs.
- Confirm timeout values are positive numbers.
- Confirm `guarded_operations` is a list of non-empty strings.
- Confirm `P2P_NETWORK_GUARD_ENABLED` is one of `true`, `false`, `1`, or `0`.

## Upgrade and migration

- Follow [Versioning](versioning.md) for interface compatibility.
- Use [Standalone migration](migration-from-standalone.md) when replacing separate Jackett or qBittorrent MCP servers.
- Re-run tests and rebuild after every source upgrade.
- Review config and package changes before enabling new tools or permissions.
