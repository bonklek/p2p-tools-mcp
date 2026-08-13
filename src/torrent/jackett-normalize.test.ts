import { describe, expect, it } from 'vitest';
import { normalizeJackettCaps, normalizeJackettSearch } from './jackett-normalize.js';

describe('Jackett normalization', () => {
  it('normalizes Torznab search results from XML', () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>Ubuntu ISO</title>
        <link>magnet:?xt=urn:btih:abc</link>
        <guid>https://example.test/t/1</guid>
        <pubDate>Sat, 01 Jan 2000 12:00:00 GMT</pubDate>
        <size>12345</size>
        <category>8000</category>
        <torznab:attr name="seeders" value="42" />
        <torznab:attr name="peers" value="50" />
        <torznab:attr name="downloadvolumefactor" value="0" />
        <torznab:attr name="uploadvolumefactor" value="1" />
      </item>
    </channel></rss>`;

    expect(normalizeJackettSearch(xml)[0]).toMatchObject({
      title: 'Ubuntu ISO',
      magnet_uri: 'magnet:?xt=urn:btih:abc',
      publish_date: '2000-01-01T12:00:00.000Z',
      size_bytes: 12345,
      categories: [8000],
      seeders: 42,
      peers: 50,
      leechers: 8,
      download_volume_factor: 0,
      upload_volume_factor: 1
    });
    expect(normalizeJackettSearch(xml)[0]).not.toHaveProperty('download_url');
    expect(normalizeJackettSearch(xml)[0]).not.toHaveProperty('details_url');
    expect(normalizeJackettSearch(xml)[0]).not.toHaveProperty('raw_attrs');
  });

  it('normalizes caps categories from XML', () => {
    const xml = `<caps><categories><category id="8000" name="Other"><subcat id="8010" name="Misc" /></category></categories></caps>`;

    expect(normalizeJackettCaps(xml).categories).toEqual([
      { id: 8000, name: 'Other', subcategories: [{ id: 8010, name: 'Misc' }] }
    ]);
  });

  it('strips tracker URLs and passkeys from returned magnet links', () => {
    const xml = `<rss><channel><item><title>Safe</title><link>magnet:?xt=urn:btih:abc&amp;tr=https%3A%2F%2Ftracker.test%2Fprivate-passkey</link></item></channel></rss>`;

    expect(normalizeJackettSearch(xml)[0].magnet_uri).toBe('magnet:?xt=urn:btih:abc');
  });

  it('rejects malformed XML instead of attempting regex recovery', () => {
    expect(() => normalizeJackettSearch('<rss><channel>')).toThrowError('Failed to parse Torznab search XML');
  });
});
