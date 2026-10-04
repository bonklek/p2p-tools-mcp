import unittest
from unittest.mock import patch

import enrich_music as music


class EnrichmentLookupTests(unittest.TestCase):
    def test_normalization_separates_words_at_punctuation(self):
        self.assertEqual(music.normalized('Sister Golden Hair [Live].flac'),
                         'sister golden hair live flac')

    def test_embedded_fallback_requires_complete_matching_tags(self):
        item = dict(self.item)
        self.assertTrue(music.embedded_fallback_allowed(item, 'Real Love Baby', 'FATHER JOHN MISTY', 'Real Love Baby'))
        self.assertFalse(music.embedded_fallback_allowed(item, 'Real Love Baby', 'FATHER JOHN MISTY', 'Greatish Hits'))
        self.assertFalse(music.embedded_fallback_allowed(item, 'Real Love Baby', '', 'Real Love Baby'))

    def setUp(self):
        self.item = {'artist': 'Father John Misty', 'title': 'Real Love Baby',
                     'album': 'Real Love Baby', 'duration_ms': 189000}

    def recording(self, identifier='one', duration=189000, album='Real Love Baby'):
        return {'id': identifier, 'title': 'Real Love Baby', 'length': duration,
                'artist-credit': [{'name': 'Father John Misty'}],
                'releases': [{'id': 'release-one', 'title': album, 'date': '2016-07-26'}]}

    @patch.object(music, 'request_json')
    def test_unique_exact_match(self, request):
        request.return_value = {'recordings': [self.recording()]}
        record, status = music.lookup(self.item)
        self.assertEqual(status, 'matched')
        self.assertEqual(record['recording_id'], 'one')
        self.assertEqual(record['year'], '2016')

    @patch.object(music, 'request_json')
    def test_ambiguous_recordings_are_declined(self, request):
        request.return_value = {'recordings': [self.recording(), self.recording('two')]}
        record, status = music.lookup(self.item)
        self.assertIsNone(record)
        self.assertEqual(status, 'ambiguous_recording')

    @patch.object(music, 'request_json')
    def test_wrong_duration_or_unproven_edition_outside_tight_window_is_declined(self, request):
        request.return_value = {'recordings': [self.recording(duration=250000), self.recording(album='Other', duration=192000)]}
        record, status = music.lookup(self.item)
        self.assertIsNone(record)
        self.assertEqual(status, 'no_exact_match')

    @patch.object(music, 'request_json')
    def test_exact_recording_does_not_invent_release_metadata(self, request):
        request.return_value = {'recordings': [self.recording(album='Other')]}
        record, status = music.lookup(self.item)
        self.assertEqual(status, 'matched')
        self.assertEqual(record['release_ids'], [])
        self.assertEqual(record['year'], '')

    @patch.object(music, 'request_json')
    def test_track_number_from_unique_position(self, request):
        request.return_value = {'media': [{'tracks': [{'position': 1, 'recording': {'id': 'one'}},
                                                       {'position': 2, 'recording': {'id': 'other'}}]}]}
        self.assertEqual(music.release_track_number('release-one', 'one'), 1)

    @patch.object(music, 'request_json')
    def test_remaster_suffix_falls_back_to_base_title(self, request):
        item = dict(self.item, title='Real Love Baby - 2016 Remaster')
        request.side_effect = [{'recordings': []}, {'recordings': [self.recording()]}]
        record, status = music.lookup(item)
        self.assertEqual(status, 'matched')
        self.assertEqual(record['title'], item['title'])
        self.assertEqual(request.call_count, 2)


if __name__ == '__main__':
    unittest.main()
