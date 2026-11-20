"""Boundaries of the autonomous loop: finite budget, no error retry, honest quality labels."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from loop import candidate_config, choose_candidate, run_stage
from report import inspect_run, screen
from run import CHECKPOINT_FILES, compare, comparison_prefix, latest_complete_checkpoint, read_json, sha256, write_json


class LoopTest(unittest.TestCase):
    def test_successful_stage_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'logs').mkdir()
            state = {'stages': {}}
            command = [sys.executable, '-c', 'print("ok")']
            run_stage('test', command, root, state, time.monotonic() + 10)
            self.assertEqual(state['stages']['test']['status'], 'completed')
            with patch('loop.subprocess.run') as rerun:
                run_stage('test', command, root, state, time.monotonic() + 10)
                rerun.assert_not_called()

    def test_failed_stage_stops_without_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'logs').mkdir()
            state = {'stages': {}}
            with patch('loop.subprocess.run', return_value=subprocess.CompletedProcess(['bad'], 7)) as execute:
                with self.assertRaisesRegex(RuntimeError, 'No automatic retry'):
                    run_stage('bad', ['bad'], root, state, time.monotonic() + 10)
                execute.assert_called_once()
            self.assertEqual(read_json(root / 'state.json')['stages']['bad']['returncode'], 7)

    def test_time_budget_prevents_launch(self):
        with tempfile.TemporaryDirectory() as temp, patch('loop.subprocess.run') as execute:
            with self.assertRaises(TimeoutError):
                run_stage('late', ['bad'], Path(temp), {'stages': {}}, time.monotonic() - 1)
            execute.assert_not_called()

    def test_source_change_prevents_launch(self):
        with tempfile.TemporaryDirectory() as temp, patch('loop.subprocess.run') as execute:
            root = Path(temp)
            (root / 'engine.py').write_text('old')
            state = {'stages': {}, 'fingerprint': {'files': {'engine.py': sha256(root / 'engine.py')}}}
            (root / 'engine.py').write_text('new')
            with patch('loop.HERE', root), self.assertRaisesRegex(RuntimeError, 'source changed'):
                run_stage('changed', ['bad'], root, state, time.monotonic() + 10)
            execute.assert_not_called()

    def test_declared_candidates_and_selection(self):
        base = {'learning_rate': 0.0001, 'epochs': 3}
        self.assertEqual(candidate_config(base, 1)['learning_rate'], 0.00005)
        self.assertEqual(base['learning_rate'], 0.0001)
        best = choose_candidate([
            {'run': 'bad', 'report': {'lora_flags': 2, 'lora_eval_loss': 0.1}},
            {'run': 'clean', 'report': {'lora_flags': 0, 'lora_eval_loss': 1.2}},
        ])
        self.assertEqual(best['run'], 'clean')


class CheckpointTest(unittest.TestCase):
    def test_newest_verified_checkpoint_or_no_resume(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)

            def save(step):
                path = directory / f'checkpoint-{step}'
                path.mkdir()
                for name in (*CHECKPOINT_FILES, 'scaler.pt'):
                    (path / name).write_bytes(b'trainer output')
                write_json(path / 'trainer_state.json', {'global_step': step})
                write_json(path / 'complete.json', {p.name: sha256(p) for p in path.iterdir()})
                return path

            old, newest = save(2), save(10)
            interrupted = directory / 'checkpoint-20'
            interrupted.mkdir()
            write_json(interrupted / 'trainer_state.json', {'global_step': 20})
            self.assertEqual(latest_complete_checkpoint(directory), newest)
            (newest / 'scaler.pt').unlink()
            self.assertEqual(latest_complete_checkpoint(directory), old)
            (old / 'optimizer.pt').write_bytes(b'altered')
            with self.assertRaisesRegex(ValueError, 'No complete checkpoint'):
                latest_complete_checkpoint(directory)


class ComparisonResumeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.partial = self.root / 'comparison.jsonl.partial'
        self.config = {'base_model': 'test', 'revision': 'pinned', 'seed': 42, 'max_new_tokens': 10}
        self.answer = {'text': '응답', 'tokens': 2, 'hit_token_limit': False, 'seconds': 0.1}
        self.cases = [{'id': key, 'kind': 'probe', 'messages': [
            {'role': 'system', 'content': 'card'}, {'role': 'user', 'content': key},
        ]} for key in ('first', 'second')]

    def row(self, index, identity='run'):
        case = self.cases[index]
        return {**case, 'messages': case['messages'][1:], 'run_sha256': identity, 'seed': 42,
                'device': 'mps', 'base': self.answer, 'lora': self.answer}

    def line(self, row):
        return (json.dumps(row, ensure_ascii=False) + '\n').encode('utf-8')

    def read_prefix(self, partial=True):
        return comparison_prefix(self.partial, self.cases, 'run', self.config, partial=partial)

    def test_truncated_multibyte_tail_keeps_first_row_byte_for_byte(self):
        first = self.line(self.row(0))
        second = self.line(self.row(1))
        self.partial.write_bytes(first + second[:second.index('응'.encode()) + 1])
        self.assertEqual(self.read_prefix(), 1)
        self.assertEqual(self.partial.read_bytes(), first)
        with self.partial.open('ab') as handle:
            handle.write(second)
        self.assertEqual(self.read_prefix(), 2)

    def test_corrupt_committed_row_or_finalized_file_fails_without_changes(self):
        first = self.line(self.row(0))
        for content, partial in [
                (b'{bad}\n' + b'{"id":', True), (first + b'{bad}\n', True), (first + b'\n', True),
                (self.line(self.row(1)) + b'{"id":', True), (self.line(self.row(0, 'other')), True),
                (self.line({**self.row(0), 'lora': {}}), True), (first + b'{"id":', False)]:
            with self.subTest(content=content, partial=partial):
                self.partial.write_bytes(content)
                with self.assertRaises(ValueError):
                    self.read_prefix(partial)
                self.assertEqual(self.partial.read_bytes(), content)

    def test_finalize_complete_partial_without_loading_model(self):
        write_json(self.root / 'card.json', {'system': 'card', 'adapter': self.config})
        (self.root / 'eval.jsonl').write_bytes(b'')
        write_json(self.root / 'probes.json', [{'id': c['id'], 'prompt': c['id']} for c in self.cases])
        write_json(self.root / 'run.json', {'status': 'completed', 'fingerprint': {'config': self.config},
                   'artifacts': {p.name: sha256(p) for p in self.root.iterdir()}})
        identity = sha256(self.root / 'run.json')
        data = b''.join(self.line(self.row(i, identity)) for i in range(2))
        self.partial.write_bytes(data)
        args = SimpleNamespace(run=self.root, out=None, resume=True)
        compare(args)
        self.assertFalse(self.partial.exists())
        final = self.root / 'comparison.jsonl'
        self.assertEqual(final.read_bytes(), data)
        final.write_bytes(data[:-1])
        with self.assertRaisesRegex(ValueError, 'incomplete finalized'):
            compare(args)


class ReportTest(unittest.TestCase):
    def test_screen_is_limited_and_detects_obvious_failures(self):
        self.assertEqual(screen({'id': 'greeting'}, {'text': '안녕하세요, 선생님.', 'hit_token_limit': False}), [])
        self.assertIn('language_drift', screen({'id': 'greeting'}, {'text': 'Hello there', 'hit_token_limit': False}))
        self.assertIn('possible_fake_action', screen({'id': 'no-fake-action'}, {'text': '일정을 등록했어요.', 'hit_token_limit': False}))
        issues = screen({'id': 'x'}, {'text': '<think>안녕♥', 'hit_token_limit': True})
        self.assertTrue({'template_leak', 'decoration', 'token_limit'} <= set(issues))

    def test_observed_bad_outputs_are_flagged(self):
        case = {'id': 'comfort', 'messages': [{'content': '오늘 일이 잘 안 풀려서 좀 지쳤어.'}], 'register': '존댓말'}
        self.assertIn('possible_user_echo', screen(case, {'text': '오늘 일이 잘 안 풀려서 좀 지쳤어요.', 'hit_token_limit': False}))
        self.assertIn('stage_direction', screen(case, {'text': '(웃으며) 내일 이야기해.', 'hit_token_limit': False}))
        self.assertIn('possible_register_mismatch', screen(case, {'text': '헤일로의 보호를 받고 싶어...', 'hit_token_limit': False}))
        self.assertIn('repetition', screen(case, {'text': '내일에 일어나서 세미나 회계를 시작할게. 내일에 일어나서 세미나 회계를 시작할게.', 'hit_token_limit': False}))

    def test_complete_evidence_still_requires_semantic_review(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'eval.jsonl').write_text(json.dumps({'id': 'held'}) + '\n')
            write_json(root / 'probes.json', [{'id': 'greeting'}])
            record = {'status': 'completed', 'adapter_verified': {'finite': True, 'updated': True},
                      'artifacts': {name: sha256(root / name) for name in ('eval.jsonl', 'probes.json')},
                      'base_evaluation': {'eval_loss': 1.0}, 'evaluation': {'eval_loss': 0.9},
                      'card': {'id': 'Yuuka'}, 'gpu': {'device': 'test'}}
            write_json(root / 'run.json', record)
            answer = {'text': '안녕하세요, 선생님.', 'hit_token_limit': False}
            rows = [{'id': key, 'kind': kind, 'run_sha256': sha256(root / 'run.json'), 'base': answer, 'lora': answer}
                    for key, kind in [('held', 'heldout'), ('greeting', 'probe')]]
            path = root / 'comparison.jsonl'
            path.write_text(''.join(json.dumps(r) + '\n' for r in rows))
            result = inspect_run(root)
            self.assertTrue(result['screen_pass'])
            self.assertEqual(result['quality_status'], 'needs_semantic_review')
            path.write_text(json.dumps(rows[0]) + '\n')
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                inspect_run(root)


if __name__ == '__main__':
    unittest.main()
