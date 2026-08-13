# p2p-tools-mcp

One npm package with a unified CLI and two local-first MCP servers for VPN checks, Jackett search, and qBittorrent lifecycle operations:

- `p2p-tools` provides the same operations as a JSON-first command-line interface.
- `vpn-mcp` controls and inspects a supported NordVPN CLI.
- `torrent-mcp` exposes explicit `jackett_*` and `qbittorrent_*` tools.

All three entrypoints share one configuration loader, validated operation layer, network guard, normalized responses, credential/path redaction, and fixed public errors. The MCP servers use stdio and keep VPN lifecycle separate from torrent lifecycle.

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

- Node.js 20 or newer. CI currently tests Node.js 24 on Windows, macOS, and Linux.
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

On Windows, set `vpn.command` to the trusted absolute path of the NordVPN command executable. The adapter deliberately does not inherit the caller's search path.

File-permission hardening is optional. If the host is shared or its default file permissions are broad, restrict the populated configuration to the account that launches `p2p-tools` or either MCP server.

## CLI

The same package installs `p2p-tools` alongside `vpn-mcp` and `torrent-mcp`:

```sh
p2p-tools vpn status
p2p-tools jackett search --query "example query" --limit 25
p2p-tools qbit list --filter downloading
```

The CLI writes the same `{ "ok": true, "data": ... }` and `{ "ok": false, "error": ... }` envelopes as the MCP tools. It exits with `0` for success, `1` for an operation failure, and `2` for invalid invocation or configuration. Use `--stdin` to supply a JSON object and `--compact` for one-line output.

See the [CLI Guide](docs/cli.md) for every command, option, stdin examples, and delete confirmation behavior.

## Canonical tools

`vpn-mcp`:

- `vpn_status`
- `vpn_connect`
- `vpn_disconnect`
- `vpn_public_ip`
- `vpn_require_active`

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
- `qbittorrent_delete_torrent` keeps downloaded files unless `delete_files: true` is supplied.
- The network guard is fail-closed for configured operations, but it does not connect the VPN automatically.

## Documentation

- [User Guide](docs/user-guide.md): setup, configuration, tool arguments, verification, privacy, and troubleshooting.
- [CLI Guide](docs/cli.md): CLI installation, commands, options, JSON input, output, and exit codes.
- [Hermes wiring](docs/hermes-config.md): focused MCP registration examples.
- [Standalone migration](docs/migration-from-standalone.md): migrate from separate Jackett/qBittorrent servers.
- [Torrent-side VPN isolation](deploy/vpn-qbit/README.md): containerized network-boundary deployment.
- [Versioning](docs/versioning.md): compatibility and release policy.
- [Example config](examples/config.yaml): annotated configuration template.

## Development

```sh
npm test          # Vitest suite
npm run check     # TypeScript validation without output
npm run build     # compile into dist/
```

Generated binaries:

- `dist/p2p-tools.js`
- `dist/vpn-mcp.js`
- `dist/torrent-mcp.js`

## License

Released under the [Viral Public License](LICENSE). The VPL applies its full terms to redistribution and to works that copy, depend on, link to, derive from, or combine with this work.
