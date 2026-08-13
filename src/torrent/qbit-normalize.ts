import type { QbitTorrentInfo, QbitTorrentProperties } from './qbit-types.js';

const COMPLETED = new Set(['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'checkingUP']);
const DOWNLOADING = new Set(['downloading', 'forcedDL', 'metaDL', 'stalledDL', 'queuedDL', 'checkingDL', 'moving', 'allocating']);
const PAUSED = new Set(['pausedUP', 'pausedDL', 'stoppedUP', 'stoppedDL']);

export function normalizeTorrent(torrent: QbitTorrentInfo) {
  return {
    hash: torrent.hash,
    name: torrent.name,
    state: normalizeState(torrent.state ?? ''),
    progress: torrent.progress ?? 0,
    size_bytes: torrent.total_size ?? torrent.size ?? 0,
    downloaded_bytes: torrent.completed ?? torrent.downloaded ?? 0,
    uploaded_bytes: torrent.uploaded ?? 0,
    download_speed: torrent.dlspeed ?? 0,
    upload_speed: torrent.upspeed ?? 0,
    eta_seconds: typeof torrent.eta === 'number' && torrent.eta >= 0 ? torrent.eta : null,
    category: torrent.category || null,
    tags: (torrent.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
    added_on: toIso(torrent.added_on),
    completed_on: toIso(torrent.completion_on),
    ratio: torrent.ratio ?? 0,
    raw_state: torrent.state ?? ''
  };
}

export function normalizeTorrentDetails(torrent: QbitTorrentInfo, properties: QbitTorrentProperties) {
  return {
    ...normalizeTorrent(torrent),
    piece_size_bytes: properties.piece_size ?? null,
    total_downloaded_bytes: properties.total_downloaded ?? null,
    total_uploaded_bytes: properties.total_uploaded ?? null,
    average_download_speed: properties.dl_speed_avg ?? null,
    average_upload_speed: properties.up_speed_avg ?? null,
    time_elapsed_seconds: properties.time_elapsed ?? null,
    seeding_time_seconds: properties.seeding_time ?? null,
    created_on: toIso(properties.creation_date)
  };
}

function normalizeState(state: string): 'downloading' | 'completed' | 'paused' | 'active' | 'inactive' | 'unknown' {
  if (COMPLETED.has(state)) return 'completed';
  if (DOWNLOADING.has(state)) return 'downloading';
  if (PAUSED.has(state)) return 'paused';
  if (state === 'error' || state === 'missingFiles') return 'inactive';
  if (state === 'checkingResumeData') return 'active';
  return 'unknown';
}

function toIso(value: number | undefined): string | null {
  return value && value > 0 ? new Date(value * 1000).toISOString() : null;
}
