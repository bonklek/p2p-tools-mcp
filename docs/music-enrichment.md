# Music pilot enrichment

The `tools/enrich_music.py` command stages completed Soulseek audio before it is copied to a phone. It expects a JSON array of objects with `path`, `artist`, `title`, `album`, and `duration_ms`. It needs Python 3.10+ and `mutagen` (`python -m pip install mutagen`).

```powershell
python tools/enrich_music.py --manifest C:\path\to\completed.json --staging-dir C:\path\to\staging --report C:\path\to\review.json
python tools/enrich_music.py --manifest C:\path\to\completed.json --staging-dir C:\path\to\staging --report C:\path\to\applied.json --apply
```

The first command previews the destination and makes no file changes. `--apply` copies verified audio into staging and fills only missing tags on the copy. Source downloads are untouched. The command checks the decoded audio duration against the requested duration (10-second tolerance), rejects conflicting embedded title or artist tags, and searches MusicBrainz for an exact artist, title, album, and recording duration (8-second tolerance). It declines multiple matching recording IDs rather than using the first hit. MusicBrainz requests use a descriptive User-Agent and at least 1.1 seconds between starts, following the [MusicBrainz API rate limit](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting).

`--allow-embedded-only` adds a conservative fallback for a completed file whose embedded title, artist, and album agree with the requested track and whose duration passed validation, but whose MusicBrainz recording or edition is unresolved. These copies go to `_EmbeddedReview` with status `staged_embedded_only`. No tags are changed on those copies. Keep them separate from MusicBrainz-confirmed files when planning a phone transfer.

When a single release and track position are identified, and the embedded album agrees, the staging path is `[YYYY] Album/NN - Title.ext`; otherwise it is `_Singles/Artist - Title.ext`. The latter is a holding layout and does not claim the track was originally a single. The report flags embedded album disagreements. Existing artwork and embedded tags are preserved. Review `no_exact_match`, `ambiguous_recording`, `duration_mismatch`, and tag conflict rows manually before adding them to a device library. A file is safe to transfer only after its report status is `staged` and the staged file is verified.
