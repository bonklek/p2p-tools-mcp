import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { McpError } from '../shared/errors.js';

interface RawAttr { '@_name'?: string; '@_value'?: string }
interface RawEnclosure { '@_url'?: string; '@_length'?: string }
interface RawItem {
  title?: string;
  guid?: string | { '#text'?: string };
  link?: string;
  comments?: string;
  pubDate?: string;
  size?: string | number;
  category?: string | string[];
  enclosure?: RawEnclosure;
  'torznab:attr'?: RawAttr | RawAttr[];
}

export interface JackettSearchResult {
  title: string;
  magnet_uri: string | null;
  infohash: string | null;
  size_bytes: number | null;
  size_human: string | null;
  seeders: number | null;
  leechers: number | null;
  peers: number | null;
  grabs: number | null;
  publish_date: string | null;
  categories: number[];
  imdb_id: string | null;
  indexer: string;
  download_volume_factor: number | null;
  upload_volume_factor: number | null;
}

export interface JackettCaps {
  indexer: string;
  server: { title: string | null; description: string | null; image: string | null };
  searching: { search: boolean; tvsearch: boolean; movie: boolean; music: boolean; book: boolean };
  categories: Array<{ id: number; name: string; subcategories: Array<{ id: number; name: string }> }>;
  tags: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true
});

export function normalizeJackettSearch(xml: string, requestedIndexer = 'all'): JackettSearchResult[] {
  const parsed = parseXml(xml, 'search') as { rss?: { channel?: { item?: RawItem | RawItem[] } } };
  const rawItems = parsed.rss?.channel?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  return items.map((item) => normalizeItem(item, requestedIndexer));
}

export function normalizeJackettCaps(xml: string, indexer = 'all'): JackettCaps {
  const parsed = parseXml(xml, 'caps') as {
    caps?: {
      server?: Record<string, string>;
      searching?: Record<string, Record<string, string>>;
      categories?: { category?: RawCategory | RawCategory[] };
      tags?: { tag?: RawTag | RawTag[] };
    }
  };
  const caps = parsed.caps;
  if (!caps) throw new McpError('TORZNAB_PARSE_ERROR', 'Torznab caps response did not contain a caps root');
  const categories = asArray(caps.categories?.category).map((category) => ({
    id: numberOrZero(category['@_id']),
    name: category['@_name'] ?? '',
    subcategories: asArray(category.subcat).map((subcat) => ({ id: numberOrZero(subcat['@_id']), name: subcat['@_name'] ?? '' }))
  }));
  const searching = caps.searching ?? {};
  return {
    indexer,
    server: {
      title: caps.server?.['@_title'] ?? null,
      description: caps.server?.['@_description'] ?? null,
      image: caps.server?.['@_image'] ?? null
    },
    searching: {
      search: available(searching.search),
      tvsearch: available(searching.tvsearch),
      movie: available(searching.movie),
      music: available(searching.music),
      book: available(searching.book)
    },
    categories,
    tags: asArray(caps.tags?.tag).map((tag) => tag['@_name'] ?? '').filter(Boolean)
  };
}

interface RawCategory { '@_id'?: string; '@_name'?: string; subcat?: RawSubcategory | RawSubcategory[] }
interface RawSubcategory { '@_id'?: string; '@_name'?: string }
interface RawTag { '@_name'?: string }

function normalizeItem(item: RawItem, requestedIndexer: string): JackettSearchResult {
  const attrs = collectAttrs(item['torznab:attr']);
  const categories = [...asArray(item.category), ...(attrs.category ?? [])]
    .map(Number)
    .filter(Number.isInteger);
  const size = firstNumber(attrs.size) ?? numberOrNull(item.size) ?? numberOrNull(item.enclosure?.['@_length']);
  const seeders = firstNumber(attrs.seeders);
  const peers = firstNumber(attrs.peers);
  const enclosureUrl = item.enclosure?.['@_url'] ?? null;
  const link = item.link ?? null;
  return {
    title: item.title ?? '',
    magnet_uri: safeMagnet(firstString(attrs.magneturl) ?? ([enclosureUrl, link].find((value) => value?.startsWith('magnet:')) ?? null)),
    infohash: firstString(attrs.infohash),
    size_bytes: size,
    size_human: size === null ? null : humanFileSize(size),
    seeders,
    leechers: firstNumber(attrs.leechers) ?? (peers !== null && seeders !== null ? Math.max(peers - seeders, 0) : null),
    peers,
    grabs: firstNumber(attrs.grabs),
    publish_date: normalizeDate(item.pubDate),
    categories: [...new Set(categories)],
    imdb_id: normalizeImdb(firstString(attrs.imdb)),
    indexer: firstString(attrs.jackettindexer) ?? firstString(attrs.indexer) ?? requestedIndexer,
    download_volume_factor: firstNumber(attrs.downloadvolumefactor),
    upload_volume_factor: firstNumber(attrs.uploadvolumefactor)
  };
}

function parseXml(xml: string, kind: string): unknown {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new McpError('TORZNAB_PARSE_ERROR', `Failed to parse Torznab ${kind} XML`);
  }
  try {
    return parser.parse(xml);
  } catch {
    throw new McpError('TORZNAB_PARSE_ERROR', `Failed to parse Torznab ${kind} XML`);
  }
}

function collectAttrs(raw: RawAttr | RawAttr[] | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const attr of asArray(raw)) {
    const name = attr['@_name']?.trim().toLowerCase();
    const value = attr['@_value']?.trim();
    if (!name || value === undefined) continue;
    (result[name] ??= []).push(value);
  }
  return result;
}

function asArray<T>(value: T | T[] | undefined): T[] { return Array.isArray(value) ? value : value ? [value] : []; }
function firstString(values: string[] | undefined): string | null { return values?.[0] ?? null; }
function safeMagnet(value: string | null): string | null {
  if (!value?.startsWith('magnet:')) return null;
  try {
    const xt = new URL(value).searchParams.get('xt');
    return xt?.toLowerCase().startsWith('urn:btih:') ? `magnet:?xt=${encodeURIComponent(xt).replace(/%3A/gi, ':')}` : null;
  } catch {
    return null;
  }
}
function firstNumber(values: string[] | undefined): number | null { return numberOrNull(values?.[0]); }
function numberOrNull(value: unknown): number | null { const parsed = Number(value); return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : null; }
function numberOrZero(value: unknown): number { return numberOrNull(value) ?? 0; }
function available(value: Record<string, string> | undefined): boolean { return value?.['@_available'] === 'yes'; }
function normalizeDate(value: string | undefined): string | null { const time = value ? Date.parse(value) : Number.NaN; return Number.isNaN(time) ? null : new Date(time).toISOString(); }
function normalizeImdb(value: string | null): string | null { return value ? (value.startsWith('tt') ? value : `tt${value}`) : null; }

function humanFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}
