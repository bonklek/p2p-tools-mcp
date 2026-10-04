import { describe, expect, it } from 'vitest';
import { filterSlskdFiles, folderOf, type SlskdFile } from './slskd-filters.js';

const files: SlskdFile[] = [
  { file_id: 'a', username: 'Alice', filename: 'Classical\\Cello Album\\Bach Cello Suite.flac', extension: 'flac', size: 34_000_000, is_locked: false, bitrate_kbps: 900, duration_seconds: 240, sample_rate_hz: 96_000, bit_depth: 24, vbr: false, free_upload_slot: true, queue_length: 0, upload_speed_bytes_per_second: 50_000, folder_result_count: 3 },
  { file_id: 'b', username: 'Bob', filename: 'Live\\Bach Cello Suite.mp3', extension: 'mp3', size: 8_000_000, is_locked: false, bitrate_kbps: 320, duration_seconds: 255, vbr: true, free_upload_slot: false, queue_length: 5, upload_speed_bytes_per_second: 500, folder_result_count: 1 },
  { file_id: 'c', username: 'Alice', filename: 'Classical\\Cello Album\\cover.jpg', extension: 'jpg', size: 10_000, is_locked: true, free_upload_slot: true, folder_result_count: 3 }
];

describe('Soulseek result filters', () => {
  it('combines text, file, audio, folder, and uploader constraints before ranking', () => {
    expect(filterSlskdFiles(files, {
      include_text: ['bach'], exclude_text: ['live'], include_folder_text: ['cello album'], exclude_folder_text: ['bootleg'],
      include_users: ['alice'], exclude_users: ['bob'], file_types: ['audio'], extensions: ['.flac'],
      min_size_bytes: 30_000_000, max_size_bytes: 40_000_000, min_bitrate_kbps: 800, max_bitrate_kbps: 1000,
      min_duration_seconds: 200, max_duration_seconds: 250, free_slot_only: true, public_only: true,
      lossless_only: true, vbr: false, min_bit_depth: 24, min_sample_rate_hz: 96_000,
      min_upload_speed_bytes_per_second: 10_000, max_queue_length: 0, min_files_in_folder: 3
    }).map((file) => file.file_id)).toEqual(['a']);
  });

  it('supports exclusion and exact-value filters', () => {
    expect(filterSlskdFiles(files, { lossy_only: true, vbr: true, exclude_extensions: ['flac'], exclude_file_types: ['image'], min_bitrate_kbps: 320, max_bitrate_kbps: 320 }).map((file) => file.file_id)).toEqual(['b']);
    expect(filterSlskdFiles(files, { exclude_bitrate_kbps: [320] }).map((file) => file.file_id)).toEqual(['a', 'c']);
    expect(filterSlskdFiles(files, { exclude_size_bytes: [34_000_000], exclude_duration_seconds: [255] }).map((file) => file.file_id)).toEqual(['c']);
  });

  it('excludes unknown values when a quality constraint requires them', () => {
    expect(filterSlskdFiles(files, { min_bit_depth: 16 }).map((file) => file.file_id)).toEqual(['a']);
    expect(filterSlskdFiles(files, { free_slot_only: true }).map((file) => file.file_id)).toEqual(['a', 'c']);
    expect(filterSlskdFiles(files, { public_only: true }).map((file) => file.file_id)).toEqual(['a', 'b']);
  });

  it('rejects impossible ranges and conflicting format requirements', () => {
    expect(() => filterSlskdFiles(files, { min_size_bytes: 10, max_size_bytes: 1 })).toThrow();
    expect(() => filterSlskdFiles(files, { lossless_only: true, lossy_only: true })).toThrow();
  });

  it('does not mistake a pathless filename for a folder', () => {
    expect(folderOf('song.flac')).toBe('');
    expect(folderOf('Album\\song.flac')).toBe('Album');
  });
});
