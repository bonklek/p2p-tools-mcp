# p2p-tools-mcp

One npm package with a unified CLI and two local-first MCP servers for VPN checks, Jackett search, and qBittorrent lifecycle operations:

- `p2p-tools` provides the same operations as a JSON-first command-line interface.
- `vpn-mcp` controls and inspects a supported NordVPN CLI.
- `torrent-mcp` exposes explicit `jackett_*` and `qbittorrent_*` tools.
- Seven optional adapters add slskd/Soulseek, Prowlarr, Gluetun, cross-seed, Transmission, Syncthing, and IPFS/Kubo. See the [basket guide](docs/basket.md) for configuration and supported operations.
- Optional Jev AI ranking scores Soulseek search metadata after results arrive; it never downloads automatically. See [Jev ranking](docs/basket.md#optional-jev-ranking).
- Completed music downloads can be checked and staged with conservative MusicBrainz metadata using [music enrichment](docs/music-enrichment.md).
- The [resumable music workflow](docs/music-workflow.md) combines duplicate planning, Soulseek acquisition, enrichment, storage guards, and verified Android delivery. `p2p-tools setup status` tells agents when user credentials are needed; `p2p-tools setup credentials` collects the slskd API key in a hidden local prompt.

All three entrypoints share one configuration loader, validated operation layer, network guard, normalized responses, credential/path redaction, and safe error guidance. The MCP servers use stdio and keep VPN lifecycle separate from torrent lifecycle.

This package is for operators who already run Jackett and qBittorrent and want an agent or script to search and manage them. MCP (Model Context Protocol) lets an agent call these operations as tools; the CLI provides the same operations directly.

## Capabilities and limits

- Search and inspect Jackett's Torznab feed (its standardized search API), then submit a usable BTIH magnet or HTTP(S) torrent URL to qBittorrent. BTIH identifies a torrent by its content hash.
- List, inspect, pause, resume, and delete explicitly identified torrents. qBittorrent 4.x/5.x protocol differences are covered by synthetic fixtures; your deployed versions still need integration testing.
- Add success means qBittorrent accepted at least part of the submission. Use list/get to verify the torrent's actual state and eventual completion.
- Search results omit download links and tracker credentials. URL-only or private-tracker results may need acquisition through the service's own UI; there is no opaque search-result-to-add resolver in this version.
- The host guard checks status before selected operations. Ongoing traffic isolation requires a correctly configured VPN network boundary or kill switch, including after the operation returns.
- Run `p2p-tools doctor` (or the `p2p_doctor` MCP tool) for read-only setup checks and recovery steps. It checks service access and the host guard; traffic isolation remains explicitly unverified.
- Optional adapters default to disabled and expose tools only when correctly configured. Each has its own deadline, concurrency limit, and bounded HTTP responses. A failed optional service leaves other tools available. `basket search` preserves per-provider failures and pending Soulseek searches.
- Redaction uses conservative patterns: it can obscure ordinary titles containing words such as “secret,” and cannot guarantee removal of every arbitrary secret embedded in untrusted text.

The [validation record](docs/validation.md) distinguishes local automated evidence from live-service and VPN checks still required. Start with the topology appropriate to your host below, then verify connectivity before adding torrents.

## Platform support

The Node.js servers and Jackett/qBittorrent integrations run on Windows, macOS, and Linux.

The bundled NordVPN adapter has narrower support:

| Capability | Linux | Windows | macOS |
| --- | --- | --- | --- |
| Connect/disconnect | [Supported CLI](https://support.nordvpn.com/hc/en-us/articles/20196094470929-How-to-install-the-NordVPN-app-on-Linux-distributions) | [Supported command switches](https://support.nordvpn.com/hc/en-us/articles/19919384880145-Connect-to-NordVPN-Windows-with-Command-Prompt) | Not supported by this adapter |
| Status and `vpn_require_active` | Supported CLI | Not supported by this adapter | Not supported by this adapter |
| Built-in torrent network guard | Supported | Use an external boundary | Use an external boundary |

For an operating-system-neutral deployment, run Jackett and qBittorrent behind a dedicated VPN container/network boundary and disable the host-level guard. See [Torrent-side VPN isolation](deploy/vpn-qbit/README.md).

## Requirements

- Built JavaScript: Node.js 20 or newer. Source development, tests, and packing: Node.js 20.19+, 22.12+, or 24+ (excluding 21/23), matching the locked tooling. CI is configured for Node.js 24 on Windows, macOS, and Linux plus 20.19/22.12 on Linux; those remote runs are not claimed as completed here.
- Jackett for search and indexer operations.
- qBittorrent with its Web UI enabled for torrent operations.
- A supported NordVPN CLI only when using `vpn-mcp` or the built-in network guard.

## Quick start

From a reviewed source checkout:

```sh
npm ci
npm test
npm run build
```

The build produces all three package commands. Try the CLI directly from the checkout:

```sh
node dist/p2p-tools.js --help
node dist/p2p-tools.js jackett category --query "audio flac"
```

Copy [the annotated configuration](examples/config.yaml) to an untracked location, add the service credentials, and register one or both servers with an MCP client:

```yaml
mcp_servers:
  torrent:
    command: node
    args: ["<repo-root>/dist/torrent-mcp.js"]
    env:
      P2P_TOOLS_CONFIG: "<private-config-file>"
```

Add `vpn-mcp` only when the host supports the required VPN operation:

```yaml
mcp_servers:
  vpn:
    command: node
    args: ["<repo-root>/dist/vpn-mcp.js"]
    env:
      P2P_TOOLS_CONFIG: "<private-config-file>"
```

Restart the MCP client after changing its registration. A server started directly in a terminal normally appears idle because it is waiting for MCP messages on stdin.

With `P2P_TOOLS_CONFIG` set, run `node dist/p2p-tools.js doctor` before your first search or addition. Address failed checks using their `next_action` guidance. Warnings, including a deliberately disabled host guard, appear separately; a completed report does not prove VPN isolation. See [doctor output and exit codes](docs/cli.md#setup-diagnostics).

## Configuration

Set `P2P_TOOLS_CONFIG` to a YAML file. When it is unset, the servers use loopback defaults for Jackett and qBittorrent, but authenticated operations will still require their credentials.

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
```

The guard configuration deliberately uses stable internal operation IDs (`torrent_search`, `torrent_add`, and so on), including when callers use the newer canonical tool names. See the [User Guide](docs/user-guide.md#network-guard) for the full mapping and environment-variable overrides.

Unknown keys/operation IDs, ambiguous aliases, non-boolean guard flags, and invalid timeout values are rejected. Timeouts are integer milliseconds from 1 to 2,147,483,647 and cover HTTP response-body reads. Service base URLs must be direct HTTP(S) endpoints without user-info credentials, queries, or fragments; redirects are rejected. Reverse-proxy path prefixes are supported.

On Windows, set `vpn.command` to the trusted absolute path of the NordVPN command executable. The adapter deliberately does not inherit the caller's search path.

File-permission hardening is optional. If the host is shared or its default file permissions are broad, restrict the populated configuration to the account that launches `p2p-tools` or either MCP server.

## CLI

The same package installs `p2p-tools` alongside `vpn-mcp` and `torrent-mcp`:

```sh
p2p-tools doctor
p2p-tools vpn status
p2p-tools jackett search --query "example query" --limit 25
p2p-tools qbit list --filter downloading
```

The CLI writes shared-handler `{ "ok": true, "data": ... }` and `{ "ok": false, "error": ... }` envelopes. It exits with `0` for success, `1` for an operation failure, and `2` for invalid invocation or configuration. Doctor returns exit `1` for a blocked report and `0` for passed checks or warnings; inspect `data.status` even when `ok` is true. Use `--stdin` to supply a JSON object to operation commands and `--compact` for one-line output.

See the [CLI Guide](docs/cli.md) for every command, option, stdin examples, and delete confirmation behavior.

## Canonical tools

`vpn-mcp`:

- `vpn_status`
- `vpn_connect`
- `vpn_disconnect`
- `vpn_public_ip`
- `vpn_require_active`

`torrent-mcp`, setup diagnostics:

- `p2p_doctor`
- `p2p_integrations` (configuration inventory without probes)
- `p2p_search` (combined search with explicit partial and pending outcomes)

Configured optional adapters additionally expose the tools listed in the [basket guide](docs/basket.md#available-operations).

`torrent-mcp`, Jackett:

- `jackett_test_connection`
- `jackett_search`
- `jackett_caps`
- `jackett_list_indexers`
- `jackett_get_category`

`torrent-mcp`, qBittorrent:

- `qbittorrent_test_connection`
- `qbittorrent_add_magnet`
- `qbittorrent_add_torrent_url`
- `qbittorrent_list_torrents`
- `qbittorrent_get_torrent`
- `qbittorrent_pause_torrent`
- `qbittorrent_resume_torrent`
- `qbittorrent_delete_torrent`

The `torrent_*` names are deprecated compatibility aliases for the 0.2 release line. New integrations should use the canonical names above.

## Safety and privacy behavior

- Successful service responses pass through a recursive credential/path redactor.
- Unexpected exceptions become stable public errors instead of exposing raw messages.
- Jackett results omit comments, arbitrary attributes, unsafe download URLs, and peer-identifying fields; safe magnet output contains only the BTIH identifier.
- qBittorrent output omits local save paths and other unnecessary raw API fields.
- VPN child processes receive a small sanitized environment.
- `vpn_public_ip` contacts an external IP-check service and returns the current public IP.
- VPN connect/disconnect results distinguish accepted commands from observed state. `state_verified: false` and `connected: null` mean the state could not be observed, including on Windows.
- `qbittorrent_delete_torrent` keeps downloaded files unless `delete_files: true` is supplied.
- Torrent targets must be individual 40- or 64-character hexadecimal hashes. The `all` sentinel, embedded separators, and conflicting target fields are rejected.
- The network guard is fail-closed for configured operations, but it does not connect the VPN automatically.

## Documentation

- [User Guide](docs/user-guide.md): setup, configuration, tool arguments, verification, privacy, and troubleshooting.
- [CLI Guide](docs/cli.md): CLI installation, commands, options, JSON input, output, and exit codes.
- [Hermes wiring](docs/hermes-config.md): focused MCP registration examples.
- [Standalone migration](docs/migration-from-standalone.md): migrate from separate Jackett/qBittorrent servers.
- [Torrent-side VPN isolation](deploy/vpn-qbit/README.md): containerized network-boundary deployment.
- [Versioning](docs/versioning.md): compatibility and release policy.
- [Validation record](docs/validation.md): audited behavior, local checks, compatibility changes, and remaining evidence gaps.
- [Example config](examples/config.yaml): annotated configuration template.

## Development

```sh
npm test          # Vitest suite
npm run check     # TypeScript validation of source and tests without output
npm run build     # compile into dist/
```

Generated binaries:

- `dist/p2p-tools.js`
- `dist/vpn-mcp.js`
- `dist/torrent-mcp.js`

## Android integration build

The [Android transfer package](releases/android/0.3.0-alpha.1/) includes the signed ARM64 APK, Termux installer, corresponding source, checksums, and handoff guide for Hermes with Shizuku.

See the [architecture plan](docs/android-architecture-plan.md), [device integration guide](docs/android-device-integration.md), and [build validation](docs/android-build-validation.md). The Seeker-derived backend retains its upstream GPL license and additional terms. This alpha has passed build and package checks; live phone integration and playback remain pending.

## License

Released under the [Viral Public License](LICENSE). The VPL applies its full terms to redistribution and to works that copy, depend on, link to, derive from, or combine with this work.
