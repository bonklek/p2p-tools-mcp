import { z } from 'zod';

export const torrentHash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i).describe('Use a torrent hash containing 40 or 64 hexadecimal characters.');

export function magnetHash(value: string): string | null {
  if (!value.startsWith('magnet:?') || /[\s\u0000-\u001f]/.test(value)) return null;
  try {
    const xt = new URL(value).searchParams.getAll('xt');
    return xt.length === 1 && /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(xt[0]) ? xt[0] : null;
  } catch { return null; }
}

export const torrentMagnet = z.string().refine((value) => magnetHash(value) !== null).describe('Use a magnet URI with exactly one BTIH xt value: 40 hexadecimal or 32 base32 characters.');
export const torrentHttpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\s\u0000-\u001f]/.test(value);
}).describe('Use an HTTP(S) URL without user credentials or whitespace.');
export const torrentSource = z.union([torrentMagnet, torrentHttpUrl]).describe('Use a valid BTIH magnet URI or an HTTP(S) torrent URL without user credentials or whitespace.');
