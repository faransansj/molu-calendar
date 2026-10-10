#!/usr/bin/env python3
"""Bounded, resumable local train/compare/screen loop. No agents, cloud, or approval prompts."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from report import inspect_run
from run import HERE, read_json, sha256, write_json


def run_stage(key, command, root, state, deadline, stage_seconds=900):
    for name, expected in state.get('fingerprint', {}).get('files', {}).items():
        if sha256(HERE / name) != expected:
            raise RuntimeError(f'Loop source changed during execution: {name}; refusing to mix versions')
    if state['stages'].get(key, {}).get('status') == 'completed':
        return
    remaining = min(stage_seconds, deadline - time.monotonic())
    if remaining <= 0:
        raise TimeoutError('Loop time budget exhausted; completed artifacts are preserved')
    if shutil.disk_usage(root).free < 2 * 2**30:
        raise RuntimeError('Less than 2 GiB free: stop before starting another stage')
    logfile = root / 'logs' / f'{key}.log'
    entry = {'status': 'running', 'command': list(map(str, command)), 'log': str(logfile.relative_to(root))}
    state['stages'][key] = entry
    write_json(root / 'state.json', state)
    started = time.monotonic()
    print(f'[{key}] starting; log={logfile}', flush=True)
    env = {**os.environ, 'PYTHONUNBUFFERED': '1', 'TOKENIZERS_PARALLELISM': 'false',
           'HF_HUB_DISABLE_PROGRESS_BARS': '1'}
    try:
        with logfile.open('a', encoding='utf-8') as handle:
            handle.write('\nCOMMAND ' + json.dumps(entry['command']) + '\n')
            handle.flush()
            process = subprocess.run(command, cwd=HERE, stdout=handle, stderr=subprocess.STDOUT,
                                     env=env, timeout=remaining, check=False)
        entry['returncode'] = process.returncode
        if process.returncode:
            raise RuntimeError(f'{key} failed (exit {process.returncode}); inspect {logfile}. No automatic retry.')
        entry['status'] = 'completed'
    except BaseException as exc:
        entry.update(status='failed', error=f'{type(exc).__name__}: {exc}')
        raise
    finally:
        entry['seconds'] = round(time.monotonic() - started, 3)
        write_json(root / 'state.json', state)
    print(f'[{key}] completed in {entry["seconds"]}s', flush=True)


def candidate_config(base, index):
    return {**base, 'learning_rate': base['learning_rate'] / (2**index)}


def choose_candidate(candidates):
    return min(candidates, key=lambda c: (c['report']['lora_flags'], c['report']['lora_eval_loss']))


def summarize(root, state):
    selected = {}
    for character, candidates in state['candidates'].items():
        if not candidates:
            continue
        best = choose_candidate(candidates)
        selected[character] = {'run': best['run'], 'card': best['run'] + '/card.json',
                               'adapter': best['run'] + '/adapter', 'report': best['report']}
    summary = {'status': state['status'], 'selected': selected, 'errors': state.get('error'),
               'quality_status': 'needs_semantic_review',
               'notice': 'Execution success is NOT voice-quality approval. No automatic app deployment.'}
    write_json(root / 'summary.json', summary)
    lines = ['# Local LoRA loop', '', f'Status: {state["status"]}', '',
             '| Character | Selected run | Base / LoRA eval loss | Base / LoRA flags | Screen |',
             '|---|---|---|---|---|']
    for character, item in selected.items():
        r = item['report']
        lines.append(f'| {character} | [{item["run"]}]({item["run"]}/report.json) | '
                     f'{r["base_eval_loss"]:.4f} / {r["lora_eval_loss"]:.4f} | '
                     f'{r["base_flags"]} / {r["lora_flags"]} | {r["screen_pass"]} |')
    lines += ['', 'Screening is heuristic. Read comparison.jsonl and review Korean voice, relevance, '
              'scene leakage, and unsupported app actions. These are experimental adapters, not approved releases.']
    if state.get('error'):
        lines += ['', 'Error: ' + state['error']]
    (root / 'summary.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def execute(args):
    root = args.out.resolve()
    root.mkdir(parents=True, exist_ok=True)
    scripts = ('run.py', 'report.py', 'loop.py', 'prepare.py', 'export_cards.ts', 'test_stack.py')
    # Use the full-repo assembler when available; portable packs use their frozen data.
    source = HERE.parents[1] / 'public/resource/persona/characters.json'
    regenerate = source.exists() and shutil.which('node') is not None
    fingerprint = {
        'config': read_json(args.config), 'characters': args.characters, 'attempts': args.attempts,
        'device': args.device, 'qlora': args.qlora,
        'files': {name: sha256(HERE / name) for name in (*scripts, 'uv.lock', 'probes.json', 'source.json')},
        'input': sha256(source if regenerate else HERE / 'data/manifest.json'),
        'data_mode': 'app_assembler' if regenerate else 'portable_snapshot',
    }
    state_path = root / 'state.json'
    if args.resume:
        state = read_json(state_path)
        if state['fingerprint'] != fingerprint:
            raise ValueError('Loop code/config/input changed; choose a new --out instead of mixing experiments')
    else:
        if any(root.iterdir()):
            raise ValueError('Loop output is non-empty; choose a fresh --out or explicitly --resume')
        state = {'status': 'running', 'fingerprint': fingerprint, 'stages': {},
                 'candidates': {key: [] for key in args.characters}}
    (root / 'logs').mkdir(exist_ok=True)
    if not args.resume:
        (root / 'source').mkdir()
        for name in fingerprint['files']:
            shutil.copyfile(HERE / name, root / 'source' / name)
    state['status'] = 'running'
    state.pop('error', None)
    write_json(state_path, state)
    deadline = time.monotonic() + args.minutes * 60
    python = sys.executable
    try:
        run_stage('device', [python, HERE / 'run.py', 'check', '--device', args.device], root, state, deadline)
        run_stage('offline-stack', [python, HERE / 'test_stack.py'], root, state, deadline)
        if regenerate:
            run_stage('prepare', [python, HERE / 'prepare.py', '--output', root / 'data'], root, state, deadline)
        elif not (root / 'data').exists():
            shutil.copytree(HERE / 'data', root / 'data')
        config_path = root / 'pilot.json'
        write_json(config_path, fingerprint['config'])
        run_stage('validate', [python, HERE / 'run.py', 'validate', '--data', root / 'data', '--config', config_path], root, state, deadline)
        for character in args.characters:
            existing = state['candidates'][character]
            for index in range(args.attempts):
                candidate = f'{character}-{index + 1:02d}'
                path = root / candidate
                cfg = root / f'{candidate}.json'
                write_json(cfg, candidate_config(fingerprint['config'], index))
                command = [python, HERE / 'run.py', 'train', '--character', character, '--config', cfg,
                           '--data', root / 'data', '--out', path, '--device', args.device]
                if args.qlora:
                    command.append('--qlora')
                training = state['stages'].get(candidate + '-train', {})
                if training and training.get('status') != 'completed' and (path / 'run.json').exists():
                    checkpoints = list((path / 'checkpoints').glob('checkpoint-*/trainer_state.json'))
                    if not checkpoints:
                        raise RuntimeError(f'{candidate}: interrupted before a checkpoint. Preserve logs and start a fresh loop directory.')
                    command.append('--resume')
                run_stage(candidate + '-train', command, root, state, deadline)
                run_stage(candidate + '-compare', [python, HERE / 'run.py', 'compare', '--run', path,
                                                  '--device', args.device, '--resume'], root, state, deadline)
                # Recheck evidence even when expensive stages were skipped on resume.
                result = inspect_run(path)
                write_json(path / 'report.json', result)
                existing[:] = [c for c in existing if c['run'] != candidate]
                existing.append({'run': candidate, 'report': result})
                write_json(state_path, state)
                summarize(root, state)
                print(f'[{candidate}] screen={result["screen_pass"]}, base/lora flags='
                      f'{result["base_flags"]}/{result["lora_flags"]}', flush=True)
                if result['screen_pass']:
                    break
        state['status'] = 'completed_with_review_required'
    except BaseException as exc:
        state.update(status='failed', error=f'{type(exc).__name__}: {exc}')
        raise
    finally:
        write_json(state_path, state)
        summarize(root, state)
    print(f'Loop finished: {root / "summary.md"}; inspect answers before using adapters.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=HERE / 'runs' / 'auto')
    parser.add_argument('--config', type=Path, default=HERE / 'pilot.json')
    parser.add_argument('--characters', nargs='+', choices=('Yuuka', 'CH0069', 'Aris'), default=['Yuuka', 'CH0069'])
    parser.add_argument('--device', choices=('auto', 'cuda', 'mps'), default='auto')
    parser.add_argument('--attempts', type=int, choices=(1, 2), default=2)
    parser.add_argument('--minutes', type=int, default=40, help='Wall-clock budget per invocation (1..120)')
    parser.add_argument('--qlora', action='store_true')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.minutes <= 120 or len(set(args.characters)) != len(args.characters):
        parser.error('Use 1..120 minutes and unique characters')
    (HERE / 'runs').mkdir(exist_ok=True)
    # Kernel lock releases on crash; never guess from stale PID files or run two GPU loops here.
    with (HERE / 'runs' / '.device.lock').open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error('Another local training loop is running in this workspace')
        execute(args)


if __name__ == '__main__':
    main()
