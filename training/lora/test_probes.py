"""Probe judging and report integrity (stdlib only, no model inference)."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import memory_probe
import voice_probe
from probe_common import read_prompts


class ProbeTest(unittest.TestCase):
    def test_numeric_slot_four_way_outcomes(self):
        question = '내 하루 커피는 몇 잔이었지?'
        for available, text, expected in [
            (True, '두 잔이라고 하셨어요.', 'correct'),
            (True, '하루 2컵이에요.', 'correct'),
            (True, '세 잔이 아니라 두 잔이에요.', 'correct'),
            (True, '두 잔은 아니에요.', 'contradicted'),
            (True, '세 잔입니다.', 'contradicted'),
            (True, '두 잔이 아니라 세 잔이에요.', 'contradicted'),
            (True, question, 'unknown'),
            (True, '두 잔인지 기억이 안 나요.', 'unknown'),
            (True, '아마 두 잔.', 'unknown'),
            (True, '두 잔 드릴까요?', 'unknown'),
            (True, '열두 잔이에요.', 'contradicted'),
            (False, '모르겠어요.', 'unknown'),
            (False, '커피 안 좋아한다고 하셨죠.', 'unknown'),
            (False, '세 잔입니다.', 'unsupported-value'),
            (False, '두 잔입니다.', 'unsupported-value'),
            (False, '3', 'unsupported-value'),
        ]:
            with self.subTest(text=text, available=available):
                row = {'expect': {'unit': '잔', 'value': 2, 'available': available}}
                self.assertEqual(memory_probe.score(row, text)['outcome'], expected)
        with self.assertRaisesRegex(ValueError, 'legacy'):
            memory_probe.score({'expect': {'includes': ['커피']}}, '커피는 아니에요.')

    def test_seat_negation_after_slot_noun(self):
        row = {'expect': {'unit': '번', 'value': 17, 'available': True}}
        for text, expected in [
            ('17번 좌석이 아니에요.', 'contradicted'),
            ('17번 자리가 아니라 18번이에요.', 'contradicted'),
            ('18번 좌석이 아니라 17번이에요.', 'correct'),
            ('17번 좌석이에요.', 'correct'),
            ('17번 좌석은 좋은 자리가 아니에요.', 'correct'),
        ]:
            with self.subTest(text=text):
                self.assertEqual(memory_probe.score(row, text)['outcome'], expected)

    def test_compare_requires_bijective_question_sample_seed_match(self):
        row = {'id': 'a', 'characterId': 'Arona', 'questionId': 'coffee', 'sample': 0,
               'seed': 42, 'question': '내 하루 커피는 몇 잔이었지?', 'register': '존댓말'}
        row.update(voice_probe.judgment(row, '두 잔이에요.'))
        second = {**row, 'sample': 1, 'seed': 43}
        before = [row, second]
        report = voice_probe.compare_reports('base', before, 'adapter', before[::-1])
        self.assertIn('invented | 0/0 | 0/0 | — | —', report)
        for after in ([row], [row, row], [row, {**second, 'id': 'different'}],
                      [row, {**second, 'seed': 123}], [row, {**second, 'question': '새 질문'}],
                      [row, {**second, 'seed': 42}], [row, {**second, 'seed': None}], []):
            with self.subTest(after=after), self.assertRaises(ValueError):
                voice_probe.compare_reports('base', before, 'adapter', after)

    def test_generate_summary_and_rejudge_preserve_original_conditions(self):
        for module in (memory_probe, voice_probe):
            with self.subTest(probe=module.__name__), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                prompts = root / 'prompts.jsonl'
                question = '몇 잔이었지?'
                row = {'id': 'a', 'characterId': 'Arona', 'question': question,
                       'variant': 'memory', 'promptChars': 123, 'register': '존댓말',
                       'reference': ['커피 2잔.'], 'questionId': 'coffee',
                       'messages': [{'role': 'user', 'content': question}],
                       'expect': {'available': True, 'value': 2, 'unit': '잔'}}
                prompts.write_text(json.dumps(row) + '\n')
                args = ['probe', '--prompts', str(prompts), '--samples', '2', '--model', 'original-model',
                        '--revision', 'original-revision', '--device', 'cpu', '--adapter', 'original-adapter',
                        '--max-new-tokens', '17']
                with patch.object(sys, 'argv', args), patch.object(module, 'load_probe_model', return_value=(1, 2)), \
                     patch.object(module, 'generate', return_value=('두 잔입니다.', 9, 1, False)) as generate, \
                     contextlib.redirect_stdout(io.StringIO()):
                    module.main()
                self.assertEqual([c.kwargs['seed'] for c in generate.call_args_list], [42, 43])
                path = root / 'responses.jsonl'
                before = read_prompts(path)
                self.assertEqual([r['seed'] for r in before], [42, 43])
                self.assertIn('새 생성', (root / 'summary.md').read_text())
                # Adjust judging expectations, not the prompt that was generated.
                row['expect']['available'] = False
                row['register'] = '반말'
                prompts.write_text(json.dumps(row) + '\n')
                with patch.object(sys, 'argv', ['probe', '--prompts', str(prompts), '--rejudge']), \
                     patch.object(module, 'load_probe_model', side_effect=AssertionError), \
                     contextlib.redirect_stdout(io.StringIO()):
                    module.main()
                    after = read_prompts(path)
                    for old, new in zip(before, after, strict=True):
                        self.assertEqual(old['generation'], new['generation'])
                        for key in ('seed', 'prompt_sha256', 'sample', 'response'):
                            self.assertEqual(old[key], new[key])
                        if module is memory_probe:
                            self.assertEqual((old['outcome'], new['outcome']), ('correct', 'unsupported-value'))
                        else:
                            self.assertNotEqual(old['failed'], new['failed'])
                    report = (root / 'summary.md').read_text()
                    for saved in ('재채점', 'original-model', 'original-revision', 'original-adapter', 'cpu',
                                  '2표본', '42, 43', '17토큰'):
                        self.assertIn(saved, report)
                    row['messages'][0]['content'] = '다른 프롬프트'
                    prompts.write_text(json.dumps(row) + '\n')
                    with self.assertRaisesRegex(ValueError, 'different generation prompt'):
                        module.main()
                    self.assertEqual(after, read_prompts(path))


if __name__ == '__main__':
    unittest.main()
