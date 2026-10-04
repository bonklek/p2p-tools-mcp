import { z } from 'zod';
import { McpError } from '../shared/errors.js';

const terms = z.array(z.string().trim().min(1).max(128)).min(1).max(20);
const extensions = z.array(z.string().trim().toLowerCase().regex(/^\.?[a-z0-9]{1,12}$/)).min(1).max(30);
const nonnegative = z.number().int().nonnegative();
const positive = z.number().int().positive();

export const slskdFiltersSchema = z.strictObject({
  include_text: terms.optional(), exclude_text: terms.optional(),
  include_folder_text: terms.optional(), exclude_folder_text: terms.optional(),
  include_users: terms.optional(), exclude_users: terms.optional(),
  file_types: z.array(z.enum(['audio', 'image', 'video', 'document', 'text', 'archive', 'executable'])).min(1).max(7).optional(),
  exclude_file_types: z.array(z.enum(['audio', 'image', 'video', 'document', 'text', 'archive', 'executable'])).min(1).max(7).optional(),
  extensions: extensions.optional(), exclude_extensions: extensions.optional(),
  min_size_bytes: nonnegative.optional(), max_size_bytes: nonnegative.optional(), exclude_size_bytes: z.array(nonnegative).max(20).optional(),
  min_bitrate_kbps: nonnegative.optional(), max_bitrate_kbps: nonnegative.optional(), exclude_bitrate_kbps: z.array(nonnegative).max(20).optional(),
  min_duration_seconds: nonnegative.optional(), max_duration_seconds: nonnegative.optional(), exclude_duration_seconds: z.array(nonnegative).max(20).optional(),
  free_slot_only: z.boolean().optional(), public_only: z.boolean().optional(),
  lossless_only: z.boolean().optional(), lossy_only: z.boolean().optional(), vbr: z.boolean().optional(),
  min_bit_depth: positive.optional(), max_bit_depth: positive.optional(),
  min_sample_rate_hz: positive.optional(), max_sample_rate_hz: positive.optional(),
  min_upload_speed_bytes_per_second: nonnegative.optional(), max_queue_length: nonnegative.optional(),
  min_files_in_folder: positive.optional()
});

export type SlskdFilters = z.infer<typeof slskdFiltersSchema>;

export interface SlskdFile {
  file_id: string; username: string; filename: string; size: number;
  extension: string; is_locked: boolean;
  bitrate_kbps?: number; duration_seconds?: number; sample_rate_hz?: number; bit_depth?: number; vbr?: boolean;
  free_upload_slot?: boolean; queue_length?: number; upload_speed_bytes_per_second?: number;
  folder_result_count?: number;
}

const groups: Record<NonNullable<SlskdFilters['file_types']>[number], Set<string>> = {
  audio: new Set(['mp3', 'flac', 'wav', 'wave', 'aiff', 'aif', 'ape', 'wv', 'alac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'dsf', 'dff', 'mid', 'midi']),
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'svg']),
  video: new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg']),
  document: new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'epub', 'mobi']),
  text: new Set(['txt', 'md', 'nfo', 'log', 'csv', 'srt', 'lrc']),
  archive: new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']),
  executable: new Set(['exe', 'msi', 'bat', 'cmd', 'ps1', 'sh', 'app', 'dmg'])
};
const lossless = new Set(['flac', 'wav', 'wave', 'aiff', 'aif', 'ape', 'wv', 'alac', 'dsf', 'dff']);
const lossy = new Set(['mp3', 'aac', 'ogg', 'oga', 'opus', 'wma']);

export function validateSlskdFilters(filters: SlskdFilters | undefined): void {
  if (!filters) return;
  if (filters.lossless_only && filters.lossy_only) throw new McpError('INVALID_ARGUMENT', 'Lossless and lossy filters cannot both be required');
  for (const [min, max] of [
    ['min_size_bytes', 'max_size_bytes'], ['min_bitrate_kbps', 'max_bitrate_kbps'],
    ['min_duration_seconds', 'max_duration_seconds'], ['min_bit_depth', 'max_bit_depth'],
    ['min_sample_rate_hz', 'max_sample_rate_hz']
  ] as const) {
    if (filters[min] !== undefined && filters[max] !== undefined && filters[min] > filters[max]) {
      throw new McpError('INVALID_ARGUMENT', `${min} exceeds ${max}`);
    }
  }
}

const normalized = (value: string) => value.toLocaleLowerCase();
export const folderOf = (filename: string) => {
  const split = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  return split < 0 ? '' : filename.slice(0, split);
};
const extensionSet = (values: string[] | undefined) => values?.map((value) => value.replace(/^\./, ''));
const anyContains = (haystack: string, needles: string[] | undefined) => !!needles?.some((needle) => normalized(haystack).includes(normalized(needle)));
const allowedByRange = (value: number | undefined, min?: number, max?: number, excluded?: number[]) => {
  if (min === undefined && max === undefined && !excluded?.length) return true;
  if (value === undefined) return min === undefined && max === undefined;
  return (min === undefined || value >= min) && (max === undefined || value <= max) && !excluded?.includes(value);
};

export function filterSlskdFiles(files: SlskdFile[], filters: SlskdFilters | undefined): SlskdFile[] {
  validateSlskdFilters(filters);
  if (!filters) return files;
  const allowedExtensions = extensionSet(filters.extensions);
  const deniedExtensions = extensionSet(filters.exclude_extensions);
  return files.filter((file) => {
    const fullText = `${file.filename} ${file.username}`;
    const folder = folderOf(file.filename);
    if (filters.include_text?.length && !anyContains(fullText, filters.include_text)) return false;
    if (anyContains(fullText, filters.exclude_text)) return false;
    if (filters.include_folder_text?.length && !anyContains(folder, filters.include_folder_text)) return false;
    if (anyContains(folder, filters.exclude_folder_text)) return false;
    if (filters.include_users?.length && !filters.include_users.some((user) => normalized(user) === normalized(file.username))) return false;
    if (filters.exclude_users?.some((user) => normalized(user) === normalized(file.username))) return false;
    if (allowedExtensions && !allowedExtensions.includes(file.extension)) return false;
    if (deniedExtensions?.includes(file.extension)) return false;
    if (filters.file_types?.length && !filters.file_types.some((type) => groups[type].has(file.extension))) return false;
    if (filters.exclude_file_types?.some((type) => groups[type].has(file.extension))) return false;
    if (!allowedByRange(file.size, filters.min_size_bytes, filters.max_size_bytes, filters.exclude_size_bytes)) return false;
    if (!allowedByRange(file.bitrate_kbps, filters.min_bitrate_kbps, filters.max_bitrate_kbps, filters.exclude_bitrate_kbps)) return false;
    if (!allowedByRange(file.duration_seconds, filters.min_duration_seconds, filters.max_duration_seconds, filters.exclude_duration_seconds)) return false;
    if (!allowedByRange(file.bit_depth, filters.min_bit_depth, filters.max_bit_depth)) return false;
    if (!allowedByRange(file.sample_rate_hz, filters.min_sample_rate_hz, filters.max_sample_rate_hz)) return false;
    if (filters.free_slot_only && file.free_upload_slot !== true) return false;
    if (filters.public_only && file.is_locked) return false;
    if (filters.lossless_only && !lossless.has(file.extension)) return false;
    if (filters.lossy_only && !lossy.has(file.extension)) return false;
    if (filters.vbr !== undefined && file.vbr !== filters.vbr) return false;
    if (filters.min_upload_speed_bytes_per_second !== undefined && (file.upload_speed_bytes_per_second === undefined || file.upload_speed_bytes_per_second < filters.min_upload_speed_bytes_per_second)) return false;
    if (filters.max_queue_length !== undefined && (file.queue_length === undefined || file.queue_length > filters.max_queue_length)) return false;
    if (filters.min_files_in_folder !== undefined && (file.folder_result_count ?? 0) < filters.min_files_in_folder) return false;
    return true;
  });
}

export function displaySlskdFile(file: SlskdFile) {
  const path = file.filename.split(/[\\/]/);
  const title = path.at(-1) || file.filename;
  const folder_name = path.length > 1 ? path.at(-2)?.slice(0, 128) : undefined;
  return {
    file_id: file.file_id, username: file.username, title, size: file.size,
    extension: file.extension, is_public: !file.is_locked,
    ...(folder_name ? { folder_name } : {}),
    ...(file.bitrate_kbps !== undefined ? { bitrate_kbps: file.bitrate_kbps } : {}),
    ...(file.duration_seconds !== undefined ? { duration_seconds: file.duration_seconds } : {}),
    ...(file.sample_rate_hz !== undefined ? { sample_rate_hz: file.sample_rate_hz } : {}),
    ...(file.bit_depth !== undefined ? { bit_depth: file.bit_depth } : {}),
    ...(file.vbr !== undefined ? { vbr: file.vbr } : {}),
    ...(file.free_upload_slot !== undefined ? { free_upload_slot: file.free_upload_slot } : {}),
    ...(file.queue_length !== undefined ? { queue_length: file.queue_length } : {}),
    ...(file.upload_speed_bytes_per_second !== undefined ? { upload_speed_bytes_per_second: file.upload_speed_bytes_per_second } : {}),
    ...(file.folder_result_count !== undefined ? { folder_result_count: file.folder_result_count } : {})
  };
}
