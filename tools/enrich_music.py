"""Stage verified audio with conservative MusicBrainz metadata.

Input is a JSON array of {path, artist, title, album, duration_ms} objects.
The source file is never modified. Ambiguous MusicBrainz matches are reported
for review; no metadata is guessed from the first search hit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import time
import unicodedata
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from mutagen import File as AudioFile
from mutagen.flac import FLAC

API = 'https://musicbrainz.org/ws/2/recording/'
USER_AGENT = 'p2p-tools-mcp/0.2.0 (https://github.com/bonklek/p2p-tools-mcp)'
last_request = 0.0
CACHE = Path(os.environ.get('MUSICBRAINZ_CACHE_DIR', str(Path.cwd() / 'work' / 'musicbrainz-cache')))


def normalized(value: str | None) -> str:
    value = unicodedata.normalize('NFKD', value or '').casefold()
    return ' '.join(''.join(c if c.isalnum() or c.isspace() else ' '
                            for c in value if not unicodedata.combining(c)).split())


def credit(record: dict) -> str:
    return ''.join(x.get('name', '') + x.get('joinphrase', '') for x in record.get('artist-credit', []) if isinstance(x, dict)).strip()


def request_json(url: str) -> dict:
    global last_request
    cached = CACHE / (hashlib.sha256(url.encode()).hexdigest() + '.json')
    if cached.exists() and time.time() - cached.stat().st_mtime < 86400:
        try:
            return json.loads(cached.read_text(encoding='utf-8'))
        except (ValueError, OSError):
            pass
    for attempt in range(3):
        time.sleep(max(0.0, 1.1 - (time.monotonic() - last_request)))
        last_request = time.monotonic()
        try:
            with urlopen(Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'}), timeout=15) as response:
                result = json.load(response)
            CACHE.mkdir(parents=True, exist_ok=True)
            temporary = cached.with_suffix('.tmp')
            temporary.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
            temporary.replace(cached)
            return result
        except (HTTPError, URLError, TimeoutError) as error:
            if isinstance(error, HTTPError) and error.code not in {429, 500, 502, 503, 504}:
                raise
            if attempt == 2:
                raise
            retry_after = error.headers.get('Retry-After', '') if isinstance(error, HTTPError) else ''
            delay = max(2 ** (attempt + 1), int(retry_after) if retry_after.isdigit() else 0)
            if delay > 30:
                raise  # Do not retry earlier than requested; defer this file for later review.
            time.sleep(delay)


def base_remaster_title(title: str) -> str:
    return re.sub(r'\s*(?:[-–—]\s*|\()(?:(?:\d{4})\s+)?remaster(?:ed)?(?:\s+\d{4})?\)?\s*$',
                  '', title, flags=re.IGNORECASE).strip()


def equivalent_title(first_title: str, second_title: str) -> bool:
    return normalized(base_remaster_title(first_title)) == normalized(base_remaster_title(second_title))


def lookup(item: dict) -> tuple[dict | None, str]:
    artist = item['artist'].split(';')[0].strip()
    title = item['title'].strip()
    duration = int(item.get('duration_ms') or 0)
    album = normalized(item.get('album'))
    search_titles = list(dict.fromkeys((title, base_remaster_title(title))))
    for search_title in search_titles:
        query = f'recording:"{search_title}" AND artist:"{artist}"'
        url = f'{API}?query={quote(query)}&fmt=json&limit=100'
        candidates = request_json(url).get('recordings', [])
        matches = []
        for recording in candidates:
            if normalized(recording.get('title')) != normalized(search_title):
                continue
            artist_names = {normalized(c.get('name')) for c in recording.get('artist-credit', []) if isinstance(c, dict)}
            if normalized(credit(recording)) != normalized(artist) and normalized(artist) not in artist_names:
                continue
            length = recording.get('length') or 0
            if duration and length and abs(duration - length) > 8000:
                continue
            releases = [r for r in recording.get('releases', []) if equivalent_title(r.get('title', ''), item.get('album', ''))] if album else []
            # A unique exact recording with a tightly matching duration can be verified
            # without proving that the Spotify edition is present among search releases.
            if album and not releases and (not duration or not length or abs(duration - length) > 2000):
                continue
            matches.append((recording, releases))
        album_matches = [(r, releases) for r, releases in matches if releases]
        if album_matches:
            matches = album_matches
        ids = {recording['id'] for recording, _ in matches}
        if len(ids) > 1:
            return None, 'ambiguous_recording'
        if len(ids) == 1:
            recording, releases = matches[0]
            years = {r.get('date', '')[:4] for r in releases if re.match(r'^\d{4}', r.get('date', ''))}
            return {'recording_id': recording['id'], 'title': title,
                    'artist': credit(recording), 'album': item.get('album') or '',
                    'year': next(iter(years)) if len(years) == 1 else '',
                    'release_ids': sorted({r['id'] for r in releases if r.get('id')})}, 'matched'
    return None, 'no_exact_match'


def release_track_number(release_id: str, recording_id: str) -> int | None:
    url = f'https://musicbrainz.org/ws/2/release/{quote(release_id)}?inc=recordings&fmt=json'
    release = request_json(url)
    positions = []
    for medium in release.get('media', []):
        for track in medium.get('tracks', []):
            if track.get('recording', {}).get('id') == recording_id:
                position = track.get('position')
                if isinstance(position, int) and position > 0:
                    positions.append(position)
    return positions[0] if len(positions) == 1 else None


def safe(value: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', value).strip(' .') or 'Unknown'


def first(audio, key: str) -> str:
    values = audio.get(key, []) if audio else []
    return str(values[0]) if values else ''


def embedded_fallback_allowed(item: dict, title: str, artist: str, album: str) -> bool:
    expected_artists = {normalized(a) for a in item['artist'].split(';')}
    return bool(title and artist and album
                and normalized(title) == normalized(item['title'])
                and any(a and a in normalized(artist) for a in expected_artists)
                and normalized(album) == normalized(item['album']))


def stage(item: dict, root: Path, apply: bool, allow_embedded_only: bool = False) -> dict:
    source = Path(item['path']).resolve(strict=True)
    result = {'path': str(source), 'artist': item['artist'], 'title': item['title']}
    if source.suffix.lower() not in {'.flac', '.mp3', '.m4a'}:
        return result | {'status': 'unsupported_format'}
    audio = AudioFile(source, easy=True)
    if audio is None or not getattr(audio, 'info', None):
        return result | {'status': 'invalid_audio'}
    actual_ms = round(audio.info.length * 1000)
    wanted_ms = int(item.get('duration_ms') or 0)
    if wanted_ms and abs(actual_ms - wanted_ms) > 10000:
        return result | {'status': 'duration_mismatch', 'duration_ms': actual_ms}
    existing_title, existing_artist = first(audio, 'title'), first(audio, 'artist')
    existing_album = first(audio, 'album')
    if existing_title and not equivalent_title(existing_title, item['title']):
        return result | {'status': 'title_tag_conflict', 'embedded_title': existing_title}
    expected_artists = {normalized(a) for a in item['artist'].split(';')}
    if existing_artist and not any(a and a in normalized(existing_artist) for a in expected_artists):
        return result | {'status': 'artist_tag_conflict', 'embedded_artist': existing_artist}
    try:
        record, match_status = lookup(item)
    except Exception as error:
        return result | {'status': 'musicbrainz_error', 'error_type': type(error).__name__,
                         'http_status': getattr(error, 'code', None)}
    if record is None:
        if allow_embedded_only and match_status in {'no_exact_match', 'ambiguous_recording'} and embedded_fallback_allowed(
                item, existing_title, existing_artist, existing_album):
            destination = root / '_EmbeddedReview' / safe(item['artist'].split(';')[0] + ' - ' + item['title'] + source.suffix.lower())
            result |= {'status': 'embedded_ready', 'musicbrainz_status': match_status,
                       'destination': str(destination), 'duration_ms': actual_ms}
            if apply:
                if destination.exists():
                    return result | {'status': 'destination_exists'}
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                result['status'] = 'staged_embedded_only'
            return result
        return result | {'status': match_status, 'duration_ms': actual_ms}
    destination = root / '_Singles' / safe(item['artist'].split(';')[0] + ' - ' + item['title'] + source.suffix.lower())
    track_number = None
    album_conflict = bool(existing_album and normalized(existing_album) != normalized(record['album']))
    if not album_conflict and record['year'] and record['album'] and len(record['release_ids']) == 1:
        try:
            track_number = release_track_number(record['release_ids'][0], record['recording_id'])
        except Exception:
            track_number = None
        if track_number is not None:
            destination = root / safe(f"[{record['year']}] {record['album']}") / safe(f"{track_number:02d} - {item['title']}{source.suffix.lower()}")
    result |= {'status': 'ready', 'recording_id': record['recording_id'],
               'release_ids': record['release_ids'], 'destination': str(destination),
               'duration_ms': actual_ms, 'track_number': track_number,
               'embedded_album_mismatch': album_conflict}
    if not apply:
        return result
    if destination.exists():
        # Resume a copy whose report was interrupted, but never accept a filename
        # collision as evidence that the existing audio is the same recording.
        if source.suffix.lower() == '.flac':
            original_stream = FLAC(source).info.md5_signature
            if original_stream and FLAC(destination).info.md5_signature == original_stream:
                return result | {'status': 'staged', 'resumed_existing_staging': True}
        return result | {'status': 'destination_exists'}
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    staged = AudioFile(destination, easy=True)
    # Fill missing fields on the copy. Existing embedded tags and artwork remain intact.
    for key, value in (('title', record['title']), ('artist', record['artist']),
                       ('album', record['album']), ('date', record['year']),
                       ('tracknumber', str(track_number) if track_number else '')):
        if value and not first(staged, key):
            staged[key] = [value]
    staged.save()
    return result | {'status': 'staged'}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--staging-dir', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--apply', action='store_true', help='Copy and fill tags on reviewed matches')
    parser.add_argument('--allow-embedded-only', action='store_true',
                        help='Stage exact, complete embedded tags in a separate review folder when MusicBrainz is unresolved')
    args = parser.parse_args()
    items = json.loads(args.manifest.read_text(encoding='utf-8'))
    if not isinstance(items, list):
        parser.error('manifest must be a JSON array')
    report = [stage(item, args.staging_dir.resolve(), args.apply, args.allow_embedded_only) for item in items]
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'total': len(report), 'status_counts': {s: sum(x['status'] == s for x in report)
        for s in sorted({x['status'] for x in report})}, 'report': str(args.report)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
