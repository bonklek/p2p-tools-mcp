# Hermes wiring

This page focuses on registering the two compiled stdio servers with Hermes. Complete setup and tool arguments are in the [User Guide](user-guide.md).

## Build first

```sh
npm ci
npm test
npm run build
```

The entrypoints are `dist/vpn-mcp.js` and `dist/torrent-mcp.js`.

## Prepare a private runtime configuration

Copy `examples/config.yaml` to an untracked location outside the repository and add the Jackett/qBittorrent credentials.

Optional hardening: on a shared host, restrict the populated file to the account that launches Hermes using the operating system's native permissions mechanism.

Do not put credentials directly in Hermes arguments. `P2P_TOOLS_CONFIG` should point to the private file.

## Add the servers

Merge the entries you need into the existing `mcp_servers` mapping in the Hermes configuration. Do not create a second `mcp_servers` key.

```yaml
mcp_servers:
  torrent:
    command: node
    args:
      - <repo-root>/dist/torrent-mcp.js
    env:
      P2P_TOOLS_CONFIG: <private-config-file>
    timeout: 180
    connect_timeout: 60

  vpn:
    command: node
    args:
      - <repo-root>/dist/vpn-mcp.js
    env:
      P2P_TOOLS_CONFIG: <private-config-file>
    timeout: 120
    connect_timeout: 60
```

Use an absolute path for each entrypoint and the private configuration. YAML accepts forward slashes on Windows; quote values containing spaces or backslashes.

The `torrent` entry works on Windows, macOS, and Linux. Register `vpn` only for operations supported by the host:

- Linux: connect, disconnect, status, require-active, and built-in guard.
- Windows: connect/disconnect switches; no supported status-dependent guard.
- macOS: manage VPN externally; the bundled NordVPN command adapter is unsupported.

Restart Hermes after changing its configuration. MCP servers and tools are discovered at startup.

## Expected tool names

Hermes normally prefixes tools with the configured server key. With the keys above, expect names similar to:

```text
mcp_vpn_vpn_status
mcp_vpn_vpn_connect
mcp_vpn_vpn_disconnect
mcp_vpn_vpn_public_ip
mcp_vpn_vpn_require_active

mcp_torrent_jackett_test_connection
mcp_torrent_jackett_search
mcp_torrent_jackett_caps
mcp_torrent_jackett_list_indexers
mcp_torrent_jackett_get_category
mcp_torrent_qbittorrent_test_connection
mcp_torrent_qbittorrent_add_magnet
mcp_torrent_qbittorrent_add_torrent_url
mcp_torrent_qbittorrent_list_torrents
mcp_torrent_qbittorrent_get_torrent
mcp_torrent_qbittorrent_pause_torrent
mcp_torrent_qbittorrent_resume_torrent
mcp_torrent_qbittorrent_delete_torrent
```

Exact prefixes depend on the server keys and Hermes version. The MCP server's unprefixed canonical names remain the source of truth.

## First verification

After restart, call:

```text
jackett_test_connection
qbittorrent_test_connection
```

For a Linux host-wide VPN deployment, also call:

```text
vpn_status
vpn_require_active
```

Then perform a narrow search and qBittorrent lifecycle smoke test using the [verification workflow](user-guide.md#verification-workflow).

## Common registration failures

- `node` is unavailable to the Hermes process: use a trusted absolute Node.js executable path or fix the service environment.
- The entrypoint does not exist: run `npm run build` and verify the configured path.
- The config cannot be read: fix current-user permissions and the path supplied in `P2P_TOOLS_CONFIG`.
- Tools are missing after an edit: restart Hermes.
- The process appears idle when run manually: this is normal for stdio MCP; it waits for protocol messages.
- The host guard blocks Windows/macOS: use an external VPN boundary and disable the unsupported host guard.

Never paste a populated runtime configuration or Hermes environment block into public logs or issue reports.
