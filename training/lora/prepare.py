#!/usr/bin/env python3
"""Offline pilot export from a small, traceable game-table snapshot. No invented replies."""
import argparse
from collections import defaultdict
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / 'tools' / 'vendor'))
from select_examples import BROKEN, clean

PILOTS = {'Yuuka': (13010, '유우카'), 'CH0069': (10122, '미카'), 'Aris': (10015, '아리스')}
FIELDS = ('MessageGroupId', 'Id', 'CharacterId', 'MessageCondition', 'ConditionValue',
          'PreConditionGroupId', 'PreConditionFavorScheduleId', 'FavorScheduleId',
          'NextGroupId', 'MessageType', 'MessageKR')
SOURCE_URL = 'https://github.com/feilongproject/ba-data/blob/JP/DB/AcademyMessangerExcelTable.json'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dump(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def snapshot(table, profiles):
    """Explicit IDs, not 'the variant with the most lines'. Keep raw Korean + graph fields."""
    by_id = {p['CharacterId']: p for p in json.loads(profiles.read_text())['DataList']}
    rows = json.loads(table.read_text())['DataList']
    characters = {}
    for key, (cid, name) in PILOTS.items():
        if by_id[cid]['PersonalNameKr'] != name:
            raise ValueError(f'{key}: profile ID/name mismatch')
        mine = [{field: row[field] for field in FIELDS} for row in rows if row['CharacterId'] == cid]
        if not mine:
            raise ValueError(f'{key}: no source rows')
        characters[key] = {'character_id': cid, 'name': name, 'rows': mine}
    return {
        'version': 1, 'source': SOURCE_URL, 'table_sha256': digest(table),
        'profiles_sha256': digest(profiles), 'characters': characters,
        'notice': 'JP branch Korean fields; fan research snapshot, not an official training license.',
    }


def extract(key, rows, branch_cap=64):
    """Enumerate real choice branches: one choice per Answer group per path, following that choice's actual edge.

    FavorRankUp starts an episode. FavorScheduleId / PreConditionFavorScheduleId
    split pre/post-story segments, but both stay in the SAME episode split.
    Never synthesize missing story dialogue or list alternative choices in one history:
    every path carries exactly one real choice per Answer group, and reaching the same
    assistant line through different choices yields separate samples (distinct IDs).
    """
    groups = defaultdict(list)
    ids = set()
    for row in rows:
        if row['Id'] in ids:
            raise ValueError(f'{key}: duplicate source ID {row["Id"]}')
        ids.add(row['Id'])
        groups[row['MessageGroupId']].append(row)
    for group in groups.values():
        group.sort(key=lambda row: row['Id'])
    roots = sorted(g for g, items in groups.items() if any(r['MessageCondition'] == 'FavorRankUp' for r in items))
    if not roots:
        raise ValueError(f'{key}: no episode boundaries')
    samples, rejected, seen, capped = [], [], set(), []
    for root in roots:
        expansions = 0
        # Each stack entry is one real conversation path: (cursor, history, row_ids, segment, choices, visited).
        stack = [(root, [], [], root, (), frozenset())]
        while stack:
            cursor, history, row_ids, segment, choices, visited = stack.pop()
            if cursor in visited:
                raise ValueError(f'{key}: cycle at {cursor}')
            if cursor not in groups:
                raise ValueError(f'{key}: missing group {cursor}')
            if cursor != root and cursor in roots:
                emit(root, key, samples, rejected, seen, history, row_ids, segment, choices)
                continue
            visited = visited | {cursor}
            items = groups[cursor]
            if any(r['PreConditionFavorScheduleId'] for r in items):
                emit(root, key, samples, rejected, seen, history, row_ids, segment, choices)
                history, row_ids, segment = [], [], cursor
            conditions = {r['MessageCondition'] for r in items}
            if conditions == {'Answer'}:
                expansions += 1
                if expansions > branch_cap:
                    capped.append(cursor)
                    continue
                for item in items:
                    if item['MessageType'] != 'Text' or not clean(item['MessageKR']):
                        raise ValueError(f'{key}: non-text/empty answer {item["Id"]}')
                    path = choices + (item['Id'],)
                    branch_history = deepcopy(history) + [{'role': 'user', 'content': clean(item['MessageKR'])}]
                    branch_rows = deepcopy(row_ids) + [[item['Id']]]
                    if item['NextGroupId']:
                        stack.append((item['NextGroupId'], branch_history, branch_rows, segment, path, visited))
                    else:
                        emit(root, key, samples, rejected, seen, branch_history, branch_rows, segment, path)
                continue
            if conditions <= {'FavorRankUp', 'None', 'Feedback'}:
                role = 'assistant'
            else:
                raise ValueError(f'{key}: unsupported group {cursor}: {conditions}')
            if any(r['MessageType'] != 'Text' or not clean(r['MessageKR']) for r in items):
                raise ValueError(f'{key}: non-text/empty group {cursor}; needs manual review')
            text = clean(' '.join(r['MessageKR'] for r in items))
            source_ids = [r['Id'] for r in items]
            if history and history[-1]['role'] == role:
                if role == 'user':
                    raise ValueError(f'{key}: consecutive Answer groups at {cursor}')
                history[-1]['content'] += ' ' + text
                row_ids[-1].extend(source_ids)
            else:
                history.append({'role': role, 'content': text})
                row_ids.append(source_ids)
            next_ids = {r['NextGroupId'] for r in items}
            if len(next_ids) != 1:
                raise ValueError(f'{key}: ambiguous continuation {cursor}')
            cursor = next_ids.pop()
            if not cursor:
                emit(root, key, samples, rejected, seen, history, row_ids, segment, choices)
                continue
            if any(r['FavorScheduleId'] for r in items):
                emit(root, key, samples, rejected, seen, history, row_ids, segment, choices)
                history, row_ids, segment = [], [], cursor
            stack.append((cursor, history, row_ids, segment, choices, visited))
    return samples, rejected, capped


def emit(root, key, samples, rejected, seen, history, row_ids, segment, choices):
    """Emit every complete user→assistant prefix of one path. Content-identical paths are kept once."""
    for index in range(1, len(history)):
        if history[index]['role'] != 'assistant' or history[index - 1]['role'] != 'user':
            continue
        messages = deepcopy(history[:index + 1])
        signature = '\n'.join(f'{message["role"]}:{message["content"]}' for message in messages)
        if signature in seen:
            continue
        seen.add(signature)
        path_tag = hashlib.sha256(','.join(str(choice) for choice in choices).encode()).hexdigest()[:8] if choices else '0'
        sample_id = f'{key}:{root}:{row_ids[index][-1]}:{path_tag}'
        if any(BROKEN.search(message['content']) or '<|' in message['content'] for message in messages):
            rejected.append({'id': sample_id, 'reason': 'broken_jamo_or_special_token'})
            continue
        samples.append({
            'id': sample_id, 'character': key, 'episode': f'{key}:{root}',
            'segment': segment, 'messages': messages,
            'source_message_ids': deepcopy(row_ids[:index + 1]),
            'choices': list(choices),
        })


def split_episodes(samples, seed=42):
    groups = defaultdict(list)
    for sample in samples:
        groups[sample['episode']].append(sample)
    if len(groups) < 3:
        raise ValueError('Need at least three usable episodes for a pilot split')
    held = min(groups, key=lambda key: hashlib.sha256(f'{seed}:{key}'.encode()).hexdigest())
    evaluation = groups[held]
    targets = {s['messages'][-1]['content'] for s in evaluation}
    train = [s for s in samples if s['episode'] != held
             and not any(m['role'] == 'assistant' and m['content'] in targets for m in s['messages'])]
    if not train or not evaluation:
        raise ValueError('Empty split after duplicate filtering')
    return train, evaluation


def prepare(source, output, cards):
    output.mkdir(parents=True, exist_ok=True)
    manifest = {'version': 1, 'source': source['source'], 'table_sha256': source['table_sha256'],
                'persona_sha256': cards['persona_sha256'], 'seed': 42, 'characters': {}, 'files': {}}
    dump(output / 'cards.json', cards)
    manifest['files']['cards.json'] = digest(output / 'cards.json')
    for key, (cid, name) in PILOTS.items():
        entry = source['characters'][key]
        if entry['character_id'] != cid or entry['name'] != name or any(r['CharacterId'] != cid for r in entry['rows']):
            raise ValueError(f'{key}: source character mismatch')
        samples, rejected, capped = extract(key, entry['rows'])
        train, evaluation = split_episodes(samples)
        for label, records in [('train', train), ('eval', evaluation)]:
            filename = f'{key}.{label}.jsonl'
            (output / filename).write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records), encoding='utf-8')
            manifest['files'][filename] = digest(output / filename)
        manifest['characters'][key] = {
            'name': name, 'character_id': cid, 'train': len(train), 'eval': len(evaluation),
            'train_episodes': sorted({s['episode'] for s in train}),
            'eval_episodes': sorted({s['episode'] for s in evaluation}),
            'rejected': rejected, 'duplicate_filtered': len(samples) - len(train) - len(evaluation),
            'branch_cap_hit': capped,
        }
    dump(output / 'manifest.json', manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=HERE / 'data')
    parser.add_argument('--source-table', type=Path, help='Optional full AcademyMessangerExcelTable.json to refresh snapshot')
    parser.add_argument('--profile-table', type=Path, help='Required with --source-table')
    args = parser.parse_args()
    if bool(args.source_table) != bool(args.profile_table):
        parser.error('--source-table and --profile-table must be supplied together')
    source_path = HERE / 'source.json'
    if args.source_table:
        dump(source_path, snapshot(args.source_table, args.profile_table))
    source = json.loads(source_path.read_text(encoding='utf-8'))
    cards = json.loads(subprocess.check_output(['node', str(HERE / 'export_cards.ts'), *PILOTS], text=True))
    manifest = prepare(source, args.output, cards)
    for key, info in manifest['characters'].items():
        print(f'{key}: train={info["train"]}, eval={info["eval"]}, rejected={len(info["rejected"])}')
    print(f'Prepared: {args.output}')


if __name__ == '__main__':
    main()
