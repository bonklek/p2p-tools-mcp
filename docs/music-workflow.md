# Music workflow and agent setup

This workflow turns structured missing-song candidates into a resumable Soulseek search, selection, metadata check, and verified Android transfer. It counts unique songs delivered to the phone. Planning does not download anything; release and source deletion each require explicit permission in both the profile and the command.

## First setup

1. Build this checkout with `npm ci` and `npm run build` (Node 20 or newer).
2. Install and run **slskd** separately. Configure its completed-download directory, Soulseek account login, API access, listening port, and a shared music library. The package talks to slskd; it does not automate the Nicotine+ desktop interface or install services.
3. Run `p2p-tools setup credentials` in a local interactive terminal. From an uninstalled checkout, use `node dist/p2p-tools.js setup credentials`. Enter the slskd URL and its API key. The API key is hidden while typing and saved outside the repository, in `~/.p2p-tools/credentials.json`, with restricted file permissions. `P2P_TOOLS_CREDENTIALS` can select another private file. Environment settings override saved credentials. The file is access restricted, not encrypted.
4. Restart any running MCP server and run `p2p-tools setup status`. If your YAML explicitly disables slskd, set `integrations.slskd.enabled: true`. Keep the network guard appropriate to your deployment; this workflow does not disable it. Other adapters are optional for music.
5. Install Python 3.10 or newer and `python -m pip install -r tools/requirements-music.txt`. Set `P2P_PYTHON` to that Python executable if needed. Install Android platform-tools and put `adb` on PATH, or set `P2P_ADB`. Connect the phone, accept its USB debugging prompt, and read its serial with `adb devices -l`.

**Agent credential protocol:** Call `p2p_setup_status` before acquisition. If the result requires user input, notify the user using the returned `user_input.agent_message` and give them the local command. Never request passwords or API keys in chat, MCP arguments, shell arguments, or logs. Wait for the user to finish, restart the server if credentials changed, then check again. Distinguish an unreachable service, rejected API key, and missing Soulseek account login.

The Soulseek account username/password belong in slskd's account configuration. For a person using Nicotine+, the account login is in its Preferences → Network; those credentials do not create a Nicotine+ automation adapter. MusicBrainz lookup uses its public API without account credentials. Jev is optional and uses its separately configured credential file; see [Jev setup](basket.md#optional-jev-ranking).

## Configure a batch

Copy [the example](../examples/music-workflow.json) and edit it for this machine. Use structured `id`, `artist`, `title`, `album`, and `duration_ms` fields from your candidate export. IDs must be unique. Set `downloads_dir` to slskd's actual completed-download folder; it must exist. Set `library_roots` to established shared libraries, excluding incoming downloads and their parent directories. Local paths resolve relative to the profile.

Choose explicit phone paths. Internal storage typically uses `/storage/emulated/0/Music`; removable storage needs the device's actual `/storage/<volume-id>/Music` path. The capacity check uses the destination's mount, including a removable card. A USB adapter does not itself guarantee Android supports that card.

`downloads_enabled: false` holds a batch. `delete_sources_after_delivery: false` preserves originals. Reserve at least 1 GiB of PC space with `pc_minimum_free_bytes`; `pc_headroom_bytes` reserves additional staging room. `phone_max_used_percent` defaults to 66. These are space guards, not download speed limits.

Use `preferences` for the existing bulk runner's Jev preferences, and `extensions` for acceptable file types. Without explicit preferences, it records observed format, sample-rate, bit-depth, and PC layout distributions and supplies the dominant audio characteristics to Jev as soft preferences. This affects Jev ranking, not exact-match selection or transcoding. By default, live recordings, remixes and other named versions remain distinct. Set `collapse_versions: true` only if you want those names treated as the same song. Album editions with the same artist/title are always deduplicated. This is a title/artist policy, not acoustic fingerprinting.

## Run and resume

```sh
p2p-tools music plan --profile /absolute/path/workflow.json
p2p-tools music start --profile /absolute/path/workflow.json
p2p-tools music status --profile /absolute/path/workflow.json
```

The first plan takes a baseline from tagged PC files and physically present, MediaStore-indexed phone files. Optional `inventory_path` accepts a JSON array of `{ "artist": "…", "title": "…" }` records for audio absent from that index. Stale phone index entries are excluded. Untagged or unindexed music may require that supplemental inventory. Duplicate candidate songs and songs present in the baseline are removed before searching.

`start` launches a local background worker and reports its PID. Inspect `status` and the session's `worker.log` to confirm progress. `run` uses the foreground instead. Searches continue independently of delivery. The existing bulk runner controls selection and durable enqueue intents; Jev auto-selection is opt-in, and saved uncertain matches need the bulk runner's approval file (`approvals_path`). No new bandwidth cap or one-download-at-a-time setting is imposed on slskd.

To release a held batch, set `downloads_enabled: true`, pause the current worker, wait until it exits, then explicitly start with `--download`. Add `--delete-sources` only when `delete_sources_after_delivery: true` is also set. Both permissions are needed:

```sh
p2p-tools music start --profile /absolute/path/workflow.json --download --delete-sources
p2p-tools music pause --profile /absolute/path/workflow.json
```

MCP equivalents, exposed by `torrent-mcp`, are `p2p_music_plan`, `p2p_music_start`, `p2p_music_status`, and `p2p_music_pause`. Start accepts `download` and `delete_sources`, both defaulting to false. Pause takes effect at operation boundaries; already queued slskd downloads continue. Pause them in slskd if needed. A single session lock prevents concurrent delivery workers. Resume using the same profile/session; changed candidate sets, source directories, phone serials, or identity policy need a fresh session.

## Verification and recovery

- Acquisition reserves the remaining bytes of outstanding downloads and staging headroom before enqueueing more. A selected file with unknown size is deferred when a byte budget is in force. Other clients' new downloads can still consume space; the space guard is not a filesystem quota.
- Completed transfers are associated with durable batch IDs and an unambiguous local filename/size match. Ambiguous local copies remain untouched.
- MusicBrainz verifies recording identity and duration. Release year and track order are added only when supported by a unique release. Existing tags and artwork are preserved. Verified album tracks use Artist / [Year] Album / Track - Title; tracks without proven album positions use `_Singles`. See [enrichment policy](music-enrichment.md).
- Ambiguous or conflicting files are held. Optional `allow_embedded_review` requires a separate `phone.review_root`; these arrivals are counted separately and do not masquerade as verified album tracks.
- Transfers use a partial filename, SHA-256 checks, and a final rename that refuses replacement. A durable phone receipt is written before local cleanup. A restart can finish interrupted cleanup after verifying the phone again.
- Source deletion requires unchanged original bytes and either identical staged bytes or matching nonzero FLAC audio-stream checksums. A retagged MP3 original is retained. Shared baseline libraries are never cleanup targets; keep them configured in slskd so incoming-folder cleanup does not empty your shares.
- Phone disconnects and space ceilings pause delivery with a reason. Status reports unique arrivals, review arrivals, backlog, storage, and the recent arrival rate. ETA is based on recent arrivals and is unavailable without measured progress. A running worker remains available to drain already queued transfers after the target is reached; pause it when finished.

This is file delivery and metadata staging. Musicolet library scanning is requested after verified delivery, but playlist import/repair is not automated here. Offline peers and rejected downloads require provider review/reselection using the existing Soulseek tools; this worker does not promise automatic peer replacement.

## Local checks

```sh
npm run check
npm test
npm run build
python -m unittest discover -s tools -p "test_*.py"
```

Tests cover storage-budget deferral/resume, credential setup states and redaction, duplicate planning, a single worker lock, removable-storage capacity, hash failures, and crash recovery before source cleanup. They use synthetic service/device fixtures; test a small real batch before scaling a new deployment.
