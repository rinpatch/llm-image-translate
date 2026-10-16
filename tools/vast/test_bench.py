import io
import json
import unittest
from unittest.mock import patch

import bench


def stream(*events):
    return io.BytesIO(b''.join(b'data: ' + json.dumps(e).encode() + b'\n\n' for e in events) + b'data: [DONE]\n\n')


class StreamingTests(unittest.TestCase):
    def test_usage_only_chunk_and_multilingual_text(self):
        response = stream(
            {'choices': [{'delta': {'role': 'assistant'}}]},
            {'choices': [{'delta': {'content': '你好'}}]},
            {'choices': [{'delta': {'content': '(1,2),(3,4)'}, 'finish_reason': 'stop'}]},
            {'choices': [], 'usage': {'completion_tokens': 12}},
        )
        with patch('urllib.request.urlopen', return_value=response):
            row = bench.request('http://localhost/v1/chat/completions', {})
        self.assertEqual(row['text'], '你好(1,2),(3,4)')
        self.assertEqual(row['output_tokens'], 12)
        self.assertEqual(row['finish'], 'stop')
        self.assertGreater(row['end_to_end_tps'], 0)
        self.assertEqual(row['timings'], {})

    def test_stream_error_is_not_a_fast_success(self):
        with patch('urllib.request.urlopen', return_value=stream({'error': {'message': 'OOM'}})):
            with self.assertRaises(RuntimeError):
                bench.request('http://localhost/v1/chat/completions', {})

    def test_failures_and_truncation_stay_visible(self):
        result = bench.summarize([
            {'error': 'timeout'},
            {'text': 'partial', 'finish': 'length', 'wall_s': 2, 'ttft_s': 1,
             'end_to_end_tps': 3, 'server_decode_tps': None},
        ])
        self.assertEqual(result['errors'], 1)
        self.assertEqual(result['truncated'], 1)
        self.assertEqual(result['median_wall_s'], 2)
        self.assertIsNone(result['median_server_decode_tps'])

    def test_incomplete_stream_is_not_a_success(self):
        response = stream({'choices': [{'delta': {'content': 'partial'}}]})
        with patch('urllib.request.urlopen', return_value=response):
            with self.assertRaises(RuntimeError):
                bench.request('http://localhost/v1/chat/completions', {})


if __name__ == '__main__':
    unittest.main()
