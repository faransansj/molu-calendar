"""Stdlib checks; never mutate production data to test failure cases."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from prepare import HERE, PILOTS, clean, extract, prepare, split_episodes
from run import encode_sample, load_data, read_json


class PipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = read_json(HERE / 'source.json')
        cls.cards = read_json(HERE / 'data' / 'cards.json')

    def test_real_sources_and_whole_episode_split(self):
        for character in PILOTS:
            rows = self.source['characters'][character]['rows']
            by_id = {r['Id']: r for r in rows}
            samples, _, _ = extract(character, rows)
            train, evaluation = split_episodes(samples)
            self.assertTrue(train and evaluation)
            self.assertFalse({r['episode'] for r in train} & {r['episode'] for r in evaluation})
            for sample in samples:
                self.assertEqual(['user', 'assistant'], [m['role'] for m in sample['messages'][-2:]])
                for message, ids in zip(sample['messages'], sample['source_message_ids'], strict=True):
                    self.assertEqual(message['content'], clean(' '.join(by_id[i]['MessageKR'] for i in ids)))
                self.assertEqual(sample['choices'], [i for ids in sample['source_message_ids']
                                                     for i in ids if by_id[i]['MessageCondition'] == 'Answer'])
            self.assertEqual(samples, extract(character, list(reversed(rows)))[0], '입력 행 순서와 무관하게 같다')
            for sample in samples:
                # 한 경로에는 선택지가 하나씩만 들어간다: 서로 다른 선택지 문장이 같은 이력에 나열되지 않는다.
                answers = [m['content'] for m in sample['messages'] if m['role'] == 'user']
                self.assertEqual(len(answers), len(set(answers)))
            held_targets = {r['messages'][-1]['content'] for r in evaluation}
            self.assertFalse(held_targets & {m['content'] for r in train for m in r['messages'] if m['role'] == 'assistant'})

    def test_thanks_does_not_receive_next_story(self):
        samples, _, _ = extract('Yuuka', self.source['characters']['Yuuka']['rows'])
        answer = next(s['messages'][-1]['content'] for s in samples if s['messages'][-2]['content'] == '도와줘서 고마워.')
        self.assertEqual(answer, '어려운 일도 아닌걸요. 그럼 좋은 하루 되세요.')
        self.assertNotIn('장난감', answer)

    def test_answer_uses_its_own_branch(self):
        rows = self.source['characters']['Yuuka']['rows']
        samples, _, capped = extract('Yuuka', rows)
        self.assertEqual(capped, [], '분기 상한에 걸리지 않는다')
        # 같은 Answer 그룹의 두 선택지가 각자의 실제 응답으로 이어지고, 한 이력에 섞이지 않는다.
        answers = {s['messages'][-2]['content']: s['messages'][-1]['content'] for s in samples}
        self.assertTrue(answers['……누구?'].startswith('하야세 유우카예요!'), answers.get('……누구?'))
        self.assertIn('다행이구요', answers['아아. 당연하지.'], answers.get('아아. 당연하지.'))
        for sample in samples:
            choices = [m['content'] for m in sample['messages'] if m['role'] == 'user']
            if '아아. 당연하지.' in choices:
                self.assertIn('아아. 당연하지.', choices)
                self.assertNotIn('……누구?', choices, '한 경로에 다른 선택지를 나열하지 않는다')
        # 선택지 하나를 지우면 그 분기만 사라진다.
        trimmed = [r for r in deepcopy(rows) if not (r['MessageGroupId'] == 130100020 and r['MessageKR'] == '아아. 당연하지.')]
        reduced, _, _ = extract('Yuuka', trimmed)
        self.assertFalse(any('다행이구요' in s['messages'][-1]['content'] for s in reduced))

    def test_future_branch_does_not_change_prefix_identity(self):
        rows = deepcopy(self.source['characters']['Yuuka']['rows'])

        def prefix():
            return next(s for s in extract('Yuuka', rows)[0] if s['source_message_ids'][-1][-1] == 126)

        original = prefix()
        self.assertEqual(original['choices'], [124])
        later = next(r for r in rows if r['Id'] == 127)
        rows.append({**later, 'Id': max(r['Id'] for r in rows) + 1, 'MessageKR': '다른 선택지'})
        self.assertEqual(prefix(), original)

    def test_no_reply_across_favor_event(self):
        samples, _, _ = extract('Aris', self.source['characters']['Aris']['rows'])
        self.assertFalse(any(s['messages'][-2]['content'] == '응? 모험……?' for s in samples))
        for sample in samples:
            if sample['episode'] == 'Aris:1001500010':
                self.assertEqual(sample['segment'], 1001500040)

    def test_broken_jamo_is_excluded_not_rewritten(self):
        samples, rejected, _ = extract('CH0069', self.source['characters']['CH0069']['rows'])
        self.assertEqual(len(rejected), 2)
        self.assertNotIn('나ㄹ', json.dumps(samples, ensure_ascii=False))

    def test_cycle_and_missing_edge_fail(self):
        for bad_next in (130100011, 987654321):
            rows = deepcopy(self.source['characters']['Yuuka']['rows'])
            next(r for r in rows if r['MessageGroupId'] == 130100011)['NextGroupId'] = bad_next
            with self.assertRaises(ValueError):
                extract('Yuuka', rows)

    def test_reproducible_export_and_checksum(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            prepare(self.source, output, self.cards)
            first = {p.name: p.read_bytes() for p in output.iterdir()}
            prepare(self.source, output, self.cards)
            self.assertEqual(first, {p.name: p.read_bytes() for p in output.iterdir()})
            for name, content in first.items():
                self.assertEqual(content, (HERE / 'data' / name).read_bytes())
            load_data(output, 'Yuuka')
            with (output / 'Yuuka.eval.jsonl').open('a') as f:
                f.write('\n')
            with self.assertRaisesRegex(ValueError, 'Dataset changed'):
                load_data(output, 'Yuuka')


class TokenizerStub:
    eos_token_id = 2

    def apply_chat_template(self, messages, tokenize, add_generation_prompt, enable_thinking):
        ids = []
        for message in messages:
            ids += [{'system': 3, 'user': 4, 'assistant': 5}[message['role']]]
            ids += [ord(c) + 10 for c in message['content']] + [2]
        return ids + ([5] if add_generation_prompt else [])


class MaskTest(unittest.TestCase):
    def test_only_final_reply_is_supervised_and_no_truncation(self):
        record = {'id': 'test', 'messages': [
            {'role': 'assistant', 'content': 'history'},
            {'role': 'user', 'content': 'question'},
            {'role': 'assistant', 'content': 'reply'},
        ]}
        card = {'system': 'shared world'}
        encoded = encode_sample(TokenizerStub(), record, card, 100)
        self.assertEqual([t for t in encoded['labels'] if t != -100], [ord(c) + 10 for c in 'reply'] + [2])
        self.assertEqual(encoded['input_ids'][-6:], encoded['labels'][-6:])
        with self.assertRaisesRegex(ValueError, 'no silent truncation'):
            encode_sample(TokenizerStub(), record, card, 5)
        record['messages'].insert(0, {'role': 'system', 'content': 'untrusted'})
        with self.assertRaisesRegex(ValueError, 'invalid conversation'):
            encode_sample(TokenizerStub(), record, card, 100)

    def test_template_drift_fails(self):
        class DriftingTemplate(TokenizerStub):
            def apply_chat_template(self, *args, **kwargs):
                result = super().apply_chat_template(*args, **kwargs)
                return [999] + result if not kwargs['add_generation_prompt'] else result
        with self.assertRaisesRegex(ValueError, 'prefix mismatch'):
            encode_sample(DriftingTemplate(), {'id': 'test', 'messages': [
                {'role': 'user', 'content': 'a'}, {'role': 'assistant', 'content': 'b'}]}, {'system': 's'}, 100)


if __name__ == '__main__':
    unittest.main()
