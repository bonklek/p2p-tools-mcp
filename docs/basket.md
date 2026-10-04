# Optional P2P integrations

The basket adds seven optional service adapters to `torrent-mcp` and the shared `p2p-tools` CLI. Each service must already be installed and configured. This package does not install services or start containers.

All seven default to disabled. Enabling an adapter exposes only its tools; an invalid adapter section disables that adapter without preventing Jackett, qBittorrent, or other correctly configured adapters from starting. Changes take effect when the CLI next runs or the MCP server restarts. The original core configuration remains strict: invalid YAML, core VPN/guard settings, and malformed core service configuration still prevent startup.

## Configure the basket

Add an `integrations` section to your private YAML. For example:

```yaml
integrations:
  prowlarr:
    enabled: true
    baseUrl: http://127.0.0.1:9696
    apiKey: <private-prowlarr-key>
    timeoutMs: 15000
    concurrency: 2
    maxResponseBytes: 1048576
  transmission:
    enabled: true
    baseUrl: http://127.0.0.1:9091
    rpcPath: /transmission/rpc
    username: <private-user>
    password: <private-passphrase>
  slskd:
    enabled: false
  gluetun:
    enabled: false
  cross_seed:
    enabled: false
  syncthing:
    enabled: false
  ipfs:
    enabled: false
```

These credentials live in private YAML; the original environment overrides do not configure optional adapters. The `enabled` flag must be the boolean `true`. Missing or false means disabled. Invalid values in an explicitly disabled section are ignored. Unknown integration names are reported without echoing those names or their values.

| YAML name | Default base URL | Authentication |
| --- | --- | --- |
| `slskd` | `http://127.0.0.1:5030` | Required `apiKey`, sent as `X-API-Key`. |
| `prowlarr` | `http://127.0.0.1:9696` | Required `apiKey`, sent as `X-API-Key`. |
| `gluetun` | `http://127.0.0.1:8000` | Required `apiKey`; authorize the two read routes in Gluetun. |
| `cross_seed` | `http://127.0.0.1:2468` | Required `apiKey` for matching; ping is unauthenticated. |
| `transmission` | `http://127.0.0.1:9091` | Optional paired `username` and `password`, sent as HTTP Basic. |
| `syncthing` | `http://127.0.0.1:8384` | Required `apiKey`, sent as `X-API-Key`. |
| `ipfs` | `http://127.0.0.1:5001` | Optional `apiKey`, sent as Bearer authorization when Kubo authorization is configured. |

Base URLs can include a reverse-proxy prefix but must use HTTP(S), with no embedded credentials, query, or fragment. Redirects are rejected. Transmission alone accepts `rpcPath` for a custom RPC route. Unsupported credential settings are rejected rather than silently ignored.

Every optional adapter accepts `timeoutMs` (1–120000; default 15000), `concurrency` (1–8; default 2), and `maxResponseBytes` (1024–8388608; default 1048576). Its deadline covers guard inspection and all requests for one operation, including body reads. Excess concurrency returns `INTEGRATION_BUSY` immediately; there is no unbounded queue. Requests are cancelled on timeout, and a slot remains occupied until underlying work actually stops. Limits apply per MCP process; separate CLI processes have separate budgets.

## Discover and diagnose

```sh
p2p-tools basket integrations
p2p-tools doctor
p2p-tools slskd download --help
```

`p2p_integrations` lists `disabled`, `misconfigured`, and `configured` states without contacting services. `doctor` adds per-integration probes when an integrations section exists. Probe states distinguish `disabled`, `misconfigured`, `healthy` (API access), `unreachable` (failed access/response), and `busy`. Unknown integration names produce a diagnostic entry.

A failed optional probe changes an otherwise passing doctor report to `attention_needed`, not `blocked`. Core service or host-guard failures retain the existing `blocked` behavior. API access does not establish peer connectivity or successful downloads. Cross-seed ping does not validate its credentials or configured indexer/client dependencies. Gluetun `running` does not verify traffic isolation.

## Available operations

CLI names use hyphens; MCP tool names use underscores. `cross-seed match` corresponds to `cross_seed_match`.

| Service | CLI actions | Scope |
| --- | --- | --- |
| slskd | `test`, `search`, `results`, `download`, `batch` | Asynchronous searches, opaque file selections, enqueue and inspect download batches. |
| Prowlarr | `test`, `indexers`, `caps`, `search` | Version, indexer metadata, capabilities, bounded search metadata. Acquisition URLs are omitted. |
| Gluetun | `test`, `public-ip` | Operational status and reported public IP. No VPN state changes. |
| cross-seed | `test`, `match` | Ping and a webhook for one explicit torrent hash. No dependency reconfiguration. |
| Transmission | `test`, `list`, `add`, `pause`, `resume`, `delete` | Explicit torrent lifecycle operations; add defaults to paused and delete retains files by default. |
| Syncthing | `test`, `connections`, `completion`, `folder-status`, `folder-errors` | Read-only device/folder inspection. Folder errors return a bounded count and a pointer to the service UI, without filenames or raw errors. |
| IPFS/Kubo | `test`, `read`, `pin-list`, `pin-add`, `pin-remove` | Local node inspection, bounded UTF-8 file previews by CID, and pin retention. Archive transfer/extraction and publication are not implemented. |

Each command supports `--help` without loading configuration. Use `--stdin` for a JSON object; source URLs, usernames, folder IDs, and device IDs are stdin-only. Other field names become flags with underscores replaced by hyphens. For example, `indexer_ids` becomes `--indexer-ids`; arrays accept comma-separated values or JSON arrays. Unknown fields remain errors.

```sh
p2p-tools prowlarr search --query "fixture" --limit 10
p2p-tools prowlarr caps --indexer-id 1
p2p-tools gluetun test
p2p-tools transmission list --limit 10
p2p-tools cross-seed match --hash 0123456789abcdef0123456789abcdef01234567
```

To add through Transmission, supply `{"source":"<BTIH-magnet-or-HTTP(S)-torrent-URL>"}` on stdin to `p2p-tools transmission add --stdin`. Pause/resume/delete take `--hashes` with explicit 40- or 64-character hexadecimal values. `transmission delete` requires `--yes`; `--delete-files` opts into file deletion. `ipfs pin-remove` also requires `--yes` and removes retention, not immediate file deletion. MCP advertises destructive annotations; the host controls its approval UX.

`ipfs read --cid <cid> --max-bytes 4096` returns a redacted UTF-8 preview, with `truncated` when more bytes were fetched. It is not a binary/archive download API. Supported identifier syntax is CIDv0 base58 or CIDv1 lowercase base32; Kubo performs full identifier/content validation. Pin-add may fetch blocks and consume storage; pin-list caps output entries, while the response byte limit bounds the service response.

## Search across providers

```sh
p2p-tools basket search --query "fixture" --providers jackett,prowlarr,slskd --limit 10
```

Omit `--providers` to use the existing Jackett search plus configured Prowlarr/slskd adapters. Explicitly requested unavailable providers produce failed entries; their failures do not discard other results. Results remain grouped by provider, with that provider's format. This first version does not rank or deduplicate across protocols.

The report has `data.status`: `complete`, `pending`, `partial`, or `failed`, plus `providers`. Each provider is `completed`, `pending`, or `failed` and carries its own envelope. A successful empty search is completed, not failed. slskd returns a pending search identifier; poll `slskd results --search-id <id>` to obtain its files.

## Soulseek selection and reconciliation

### Optional Jev ranking

Set top-level `jev.apiKeyFile` to a private local text file containing the TypeSafe AI API key. The optional `model` defaults to `jev-latest` and `timeoutMs` to 15000. Restart the MCP server after changing configuration. The key is read when ranking and is never returned in tool output.

Run `slskd search --query "artist track"`, then poll `slskd results --search-id <id>`. With Jev configured, `slskd rank --search-id <id> --limit 10` fetches that search page and returns a ranked shortlist. It uses the original Soulseek search phrase unless `--query` overrides it. The MCP equivalent is `slskd_rank`. `jev rank --query "artist track" --stdin` accepts a JSON object containing `candidates` with `id`, `title`, and optional music metadata; the MCP equivalent is `jev_rank`. At most 25 candidates are ranked per call.

### Detailed result filters and preferences

Supply a nested `filters` object to `slskd_results` or `slskd_rank` through MCP, or to `slskd results --stdin` / `slskd rank --stdin` as JSON. Filters run locally over the slskd search responses **before** the result limit or Jev ranking. For example:

```json
{
  "search_id": "<search UUID>",
  "limit": 10,
  "filters": {
    "file_types": ["audio"], "extensions": ["flac"],
    "min_bit_depth": 24, "min_sample_rate_hz": 96000,
    "free_slot_only": true, "public_only": true,
    "max_queue_length": 0
  },
  "preferences": ["Prefer the original studio release", "Avoid live recordings"],
  "preferred_users": ["trusted-peer"]
}
```

`preferences` and `preferred_users` apply to ranking, not `slskd_results`. Jev sees each `preferred_users` match as a boolean, without the username. Use a larger `slskd search --limit` when restrictive filters could eliminate a short initial search; result filtering cannot recover files slskd did not collect.

| Filter fields | Behavior |
| --- | --- |
| `include_text`, `exclude_text` | Case-insensitive phrases checked against full remote filename and username. Include alternatives are OR; exclusions reject any match. |
| `include_folder_text`, `exclude_folder_text` | Check the remote folder path locally; full paths are not returned. |
| `include_users`, `exclude_users` | Exact case-insensitive uploader names. |
| `file_types`, `exclude_file_types` | Generic audio, image, video, document, text, archive, or executable groups based on known extensions. |
| `extensions`, `exclude_extensions` | Exact filename extensions, with or without the leading dot. |
| `min_size_bytes`, `max_size_bytes`, `exclude_size_bytes` | Inclusive file-size range or exact excluded values. |
| `min_bitrate_kbps`, `max_bitrate_kbps`, `exclude_bitrate_kbps` | Inclusive bitrate range or exact excluded values. |
| `min_duration_seconds`, `max_duration_seconds`, `exclude_duration_seconds` | Inclusive duration range or exact excluded values. |
| `free_slot_only`, `public_only` | Require an available uploader slot or a file that is not locked. Locked files cannot be enqueued for download. |
| `lossless_only`, `lossy_only`, `vbr` | Require a known codec family or an explicit VBR/CBR value. Ambiguous formats do not satisfy a required codec family. |
| `min_bit_depth`, `max_bit_depth`, `min_sample_rate_hz`, `max_sample_rate_hz` | Inclusive audio-quality ranges. |
| `min_upload_speed_bytes_per_second`, `max_queue_length` | Uploader-level speed and queue constraints. |
| `min_files_in_folder` | Require this many files **returned in the same folder**; it does not prove an album is complete. |

Required numeric or boolean metadata that is absent from a peer's response excludes that file. Exact-value exclusion alone retains files with missing metadata. `total_matches` counts filtered files before the output limit, and `truncated` reports whether the limit hid matches. Country filtering is unavailable because slskd's search responses lack country, and this integration does not send peer IPs to an online geolocation service. Room, buddies, user-only network searches, and scheduled wishlist searches are also outside slskd's current network-search API path. The `include_users` result filter can narrow a global search to specified users.

The Jev request includes the query, explicit preferences, displayed titles, sizes, folder names, and available format, quality, and uploader-status metadata. Selection IDs, Soulseek usernames, and full remote directory paths stay local. The result includes probabilities and a possible `none` recommendation. It judges metadata only; review the file before an explicit `slskd download` call. TypeSafe AI may process the supplied metadata under its own service terms. [TypeSafe AI's Choice API](https://docs.typesafe.ai/api) documents the response format.

### Bulk song workflow

Put a list of up to 10,000 songs in a local JSON manifest. IDs must be unique and stable. Global filters and preferences apply to every track; a track's `filters` replaces the global filter object for that track. This file contains no credentials.

```json
{
  "version": 1,
  "search_limit": 100,
  "jev_call_budget": 100,
  "filters": { "file_types": ["audio"], "public_only": true, "min_bitrate_kbps": 320 },
  "preferences": ["Prefer studio recordings", "Avoid remixes"],
  "auto_select_jev": false,
  "tracks": [
    { "id": "song-001", "query": "Artist Song Title" },
    { "id": "song-002", "query": "Another Artist Another Song", "filters": { "extensions": ["flac"], "public_only": true } }
  ]
}
```

```powershell
p2p-tools slskd bulk --manifest C:\music\songs.json --plan
p2p-tools slskd bulk --manifest C:\music\songs.json
p2p-tools slskd bulk --manifest C:\music\songs.json --download
```

`--plan` validates the manifest without contacting slskd or Jev. A normal run searches sequentially, polls each search until complete, filters the collected results, and writes `songs.json.state.json` beside the manifest. It emits one compact JSON summary with counts and at most ten attention items; the state file holds per-song details and Jev probabilities for review. `--progress` optionally prints a small stderr milestone every 25 processed songs. Rerunning resumes pending searches and skips completed songs. `--max-items 20` bounds one run; `--retry-errors` retries failed songs. Three consecutive permanent service errors stop the run. The Jev call budget defaults to 100, is counted across resumes, and leaves further ambiguous songs for review when exhausted. A changed manifest requires a new state file, while formatting-only changes are accepted.

**Closing the laptop:** Leave the bulk command running when you close the lid. If Windows suspends the process, it continues on wake. The runner waits 15 seconds between temporary slskd or VPN failures, checks a saved search ID before submitting a search again, and starts a fresh search only when the old ID is gone or a long sleep interrupted its result. Repeatedly interrupted searches move to review rather than being mistaken for missing songs. A transfer request is checkpointed before submission; after a timeout the runner waits for slskd and inspects that batch ID without submitting the transfer again. The command needs its terminal process to remain alive; if it is closed or killed, rerun the same command with the same manifest and state file. This workflow does not install a startup task or resume after a full Windows restart.

A single public candidate whose title and displayed folder contain every query word, with no extra nonnumeric title words, can be selected locally when no preferences were supplied. Other shortlists of up to 25 candidates go to Jev. Jev's recommendation stays in review by default. To permit automatic Jev selection, set `auto_select_jev` to `true`; the default gates require model confidence and winning probability of at least 0.9 and a margin of at least 0.5 over every alternative including `none`. These values are conservative heuristics, not calibrated guarantees. Searches with more than 25 public candidates, missing matches, and uncertain transfers remain visible in the state file for review. Incomplete searches remain pending for the next run.

For reviewed songs, choose a saved public `file_id` from each item's `review_candidates` and make a separate approvals file:

```json
{ "version": 1, "choices": [{ "id": "song-001", "file_id": "<saved 64-character file ID>" }] }
```

Run `p2p-tools slskd bulk --manifest C:\music\songs.json --approvals C:\music\approvals.json --download` to queue approved selections. `--download` is always required to enqueue anything. The runner records a batch intent before submitting a transfer and inspects that batch after an interrupted or uncertain request; it never blindly retries the mutation. A search result or queued transfer is not proof of a completed or authentic audio file. The saved state and approvals are local, may contain titles and uploader names, and should be kept private.

For a Windows slskd installation, use the [official releases](https://github.com/slskd/slskd/releases) and [configuration guide](https://github.com/slskd/slskd/blob/master/docs/config.md). Give slskd its own local API key, bind the web listener to localhost, and configure Soulseek credentials. If using the same Soulseek account in Nicotine+, close Nicotine+ while slskd is connected.

On Windows, set `vpn.windowsStatusProvider: nord-egress` to opt in to a pre-operation check against NordVPN's public IP insights endpoint. The guard proceeds only when the response says the host's public IP is protected; errors and unexpected responses block the operation. This does not prove that slskd itself uses the tunnel, nor does it verify a kill switch. Without this setting, the built-in Windows status check remains unsupported and guarded searches and downloads are blocked. Reading existing slskd results and Jev ranking still works.


Search results return file titles, sizes, usernames, and `file_id` values. These IDs bind the username, exact remote filename, and size; remote directory paths are not exposed. To download, supply `search_id`, `username`, and selected `file_ids` through `slskd download --stdin`. The adapter resolves the selections from the same search immediately before enqueueing; expired or mismatched selections fail without downloading another file.

Searches accept an optional `search_id`; downloads accept an optional `batch_id`. After input validation, the adapter generates a UUID if needed, before making requests. Execution failures retain this UUID as `error.request_id` so callers can inspect `slskd results` or `slskd batch` after a timeout. Validation failures do not receive generated IDs. An ID on a guard or concurrency failure does not prove a request reached the service.

Download reports distinguish `accepted`, `partial`, and `failed`, returning `failed_file_ids` for selective retry. Batch polling reads individual transfer states and progress without returning filenames or exception text. The adapter targets slskd's batch API generation (`POST /api/v0/transfers/downloads/batches`); older installations without it return an error. There is no automatic fallback mutation to the deprecated downloads API.

## Failure and guard behavior

Single-operation failures use stable `INTEGRATION_*` codes and safe recovery steps. HTTP bodies, credentials, and raw exception details are not forwarded. Mutation timeouts can have an uncertain outcome: inspect state before retrying. The only protocol retry is Transmission's explicit HTTP 409 session challenge, retried once for that rejected request. Version negotiation is read-only; mutation errors never trigger a different RPC dialect.

Reports can have `ok: true` while recording failure or partial work: combined search and slskd batch-enqueue reports were successfully produced. Their CLI commands exit `1` for `failed` or `partial`, and `0` for complete, accepted, or pending outcomes. Inspect report status in MCP; report delivery itself is not marked as a tool failure. Input errors exit `2`; disabled/misconfigured optional commands exit `1`. Doctor keeps its documented separate exit policy.

Prowlarr/slskd searches and IPFS reads use `torrent_search` guard policy. slskd downloads, Transmission adds, cross-seed matching, and IPFS pin-add use `torrent_add`. Transmission pause/resume/delete use the corresponding internal guard IDs if included in `guarded_operations`. Read-only local service inspection and IPFS pin removal do not require host VPN inspection. No operation changes or disables VPN protection. The pre-operation guard cannot stop asynchronous work later if VPN connectivity changes; use the existing external isolation boundary for that protection.

The adapter registry contains ordinary configuration, service, timeout, and response failures. It does not provide process isolation against memory exhaustion, a process crash, or a bug in shared code. Legacy Jackett/qBittorrent operations retain their existing timeout and configuration behavior.

## Protocol evidence and compatibility

Local tests use synthetic fixtures and loopback HTTP services, not live deployments. Transmission supports 3.x–4.x, discovering the 4.1+ RPC format through a read-only legacy session request; newer major versions fail explicitly. Other adapters target the documented API contracts below, rather than claiming compatibility with every released version.

- [Prowlarr API](https://prowlarr.com/docs/api/) and [search controller](https://github.com/Prowlarr/Prowlarr/blob/develop/src/Prowlarr.Api.V1/Search/SearchController.cs).
- [slskd searches](https://github.com/slskd/slskd/blob/master/src/slskd/Search/API/Controllers/SearchesController.cs), [download controller](https://github.com/slskd/slskd/blob/master/src/slskd/Transfers/API/Controllers/TransfersController.cs), and [batch model](https://github.com/slskd/slskd/blob/master/src/slskd/Transfers/Types/Batch.cs).
- [Gluetun control-server routes](https://github.com/qdm12/gluetun-wiki/blob/main/setup/advanced/control-server.md).
- [cross-seed HTTP API](https://www.cross-seed.org/docs/reference/api).
- [Transmission current RPC](https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md) and [legacy 4.0.6 RPC](https://github.com/transmission/transmission/blob/4.0.6/docs/rpc-spec.md).
- [Syncthing REST API](https://docs.syncthing.net/dev/rest.html).
- [Kubo RPC API](https://docs.ipfs.tech/reference/kubo/rpc/) and [pin response implementation](https://github.com/ipfs/kubo/blob/master/core/commands/pin/pin.go).
