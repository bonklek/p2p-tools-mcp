# Migrate from standalone Jackett or qBittorrent MCP servers

Version 0.2 consolidates Jackett discovery and qBittorrent lifecycle operations behind the single `torrent-mcp` entrypoint. This guide keeps the old and new registrations side by side until behavior is verified.

## Tool mapping

| Earlier or compatibility name | Canonical 0.2 tool |
| --- | --- |
| Jackett connection test | `jackett_test_connection` |
| `torrent_search` | `jackett_search` |
| `torrent_caps` | `jackett_caps` |
| `torrent_list_indexers` | `jackett_list_indexers` |
| Category lookup | `jackett_get_category` |
| qBittorrent connection test | `qbittorrent_test_connection` |
| `torrent_add` with a magnet | `qbittorrent_add_magnet` |
| `torrent_add` with a URL | `qbittorrent_add_torrent_url` |
| `torrent_list` | `qbittorrent_list_torrents` |
| `torrent_get` | `qbittorrent_get_torrent` |
| `torrent_pause` | `qbittorrent_pause_torrent` |
| `torrent_resume` | `qbittorrent_resume_torrent` |
| `torrent_delete` | `qbittorrent_delete_torrent` |

The `torrent_*` aliases remain available during the 0.2 migration line. They are not recommended for new prompts, routing rules, or automation.

## Argument changes

Canonical tools use explicit snake-case fields:

- Magnet adds: `magnet_uri`
- Torrent URL adds: `torrent_url`
- Optional save location: `save_path`
- Skip checking: `skip_checking`
- Delete downloaded files: `delete_files`
- qBittorrent sorting: `sort_by`
- Typed Jackett search: `search_type`, `imdb_id`

The old generic `torrent_add` accepted several overlapping names. Split it into the magnet or URL tool during migration so the MCP schema can validate the request before it reaches qBittorrent.

## Configuration compatibility

`P2P_TOOLS_CONFIG` is the preferred configuration source. These environment variables are also accepted and override YAML:

- `JACKETT_BASE_URL`, `JACKETT_API_KEY`, `JACKETT_TIMEOUT_MS`
- `QBITTORRENT_BASE_URL`, `QBITTORRENT_USERNAME`, `QBITTORRENT_PASSWORD`, `QBITTORRENT_TIMEOUT_MS`
- `P2P_NETWORK_GUARD_ENABLED`
- `P2P_HTTP_TIMEOUT_MS`, `P2P_COMMAND_TIMEOUT_MS`
- `NORDVPN_COMMAND`, `NORDVPN_DEFAULT_COUNTRY`

The network guard still uses stable internal `torrent_*` operation IDs even when callers use canonical tools. See the [guard mapping](user-guide.md#network-guard).

## Safe cutover

1. Build and test `p2p-tools-mcp`.
2. Create a private runtime config without deleting the existing servers' configuration.
3. Register `torrent-mcp` beside the earlier server entries under a distinct MCP key.
4. Restart the MCP client.
5. Run `jackett_test_connection` and `qbittorrent_test_connection`.
6. Compare one narrow Jackett search against the earlier integration.
7. Compare a qBittorrent list response and confirm the normalized fields your client needs are present.
8. Exercise add, pause, resume, and delete against a disposable test job. Keep `delete_files` false unless data removal is intentional.
9. Update prompts, routing policy, and automation to canonical tool names.
10. Disable the earlier registrations and restart the MCP client.
11. Confirm only the canonical tools remain routed to the new `torrent-mcp` entry.
12. Archive or remove old source checkouts only after required credentials/configuration have been migrated and the new integration survives a clean restart.

## Behavioral differences to expect

- All tools use `{ "ok": true, "data": ... }` or a stable structured error envelope.
- Jackett output is normalized; arbitrary Torznab attributes, comments, and unsafe download URLs are not exposed.
- qBittorrent output is normalized and omits local save paths.
- Known service failures use public error codes/messages rather than raw HTTP or exception text.
- The network guard is separate from VPN lifecycle and never auto-connects.
- Delete keeps downloaded files unless `delete_files: true` is explicit.

If an earlier client depends on raw service fields, update that client instead of weakening the normalized privacy boundary.

## Rollback

If the cutover fails:

1. Re-enable the earlier MCP registrations.
2. Restart the client.
3. Keep the new private config for diagnosis; do not post it publicly.
4. Compare connection-test error codes and service reachability.
5. Retry the migration only after the discrepancy is understood.

Rollback should change registrations, not delete torrent data or service configuration.
