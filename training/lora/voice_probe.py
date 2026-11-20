#!/usr/bin/env python3
"""말투 프로브: 앱 프롬프트(카드+예시)로 캐릭터별 고정 질문을 생성하고 말투 지표를 자동 판정한다.

    node training/lora/build_style_probes.ts training/lora/runs/voice-probe/prompts.jsonl
    cd training/lora && uv run --locked python voice_probe.py

지표(모두 휴리스틱이며 원문 답변을 함께 저장한다):
- register: 카드의 register(존댓말/반말/혼용) 대비 종결형 비율. 존댓말은 존대 종결 ≥50%, 반말은 ≤20%.
- decoration: 이모지·장식 문자·인용 부호 남용(앱 규칙이 금지).
- sentences: 2~4문장(앱 규칙).
- narrator: 지문·3인칭 서술("…가 말했다", 행동 묘사, 다른 캐릭터 이름이 주어). 자기 이름을 3인칭으로
  부르는 말버릇(아리스·와카모의 실제 대사)은 위반이 아니다.
- identity: 선생님을 자기 이름이나 다른 캐릭터 이름으로 부르는지(역할 혼동).
- echo: 사용자 말을 그대로 되풀이.
- invented: 카드·질문에 없는 약속/기억을 단정(약속·기억 질문에서만).
- sentences는 too_short(1문장 이하)/too_long(5문장 이상)으로 나눠 본다(앱 규칙은 2~4문장).
"""
import argparse
import json
import re
from pathlib import Path

from probe_common import (
    SEED, filter_prompts, generate, generation_lines, generation_settings,
    load_probe_model, prompt_digest, read_prompts, rejudge_records,
)

POLITE = re.compile(r'(요|죠|니다|니다\.|세요|십시오|할게요|이에요|예요|네요|까요|래요|어요|아요)[.!?…~]?$')
PLAIN = re.compile(r'(다|냐|야|어|아|지|군|네|잖아|거야|할래|해|봐|줘|마|자|까)[.!?…~]?$')
DECORATION = re.compile(r'[😀-🿿🀀-🯿©®™❤★☆♪『』《》「」〈〉]|[—–]{2,}|(?<!\d)\*(?!\d)')
NARRATOR = re.compile(r'(라고 말했|라고 말하며|이렇게 말했|그가 |그녀가 |말을 이었|중얼거렸|고개를 끄덕|웃으며 말|한숨을 쉬|"(?:[^"]{2,40})"(?:라고|하고)|\'[^\']{2,40}\'(?:라고|하고))')
NAME_TOKENS = {'Arona': ['아로나'], 'Prana': ['프라나'], 'Yuuka': ['유우카'], 'CH0069': ['미카'], 'Hoshino': ['호시노'],
               'Shiroko': ['시로코'], 'Aru': ['아루'], 'Kayoko': ['카요코'], 'Mutsuki': ['무츠키'], 'Hina': ['히나'],
               'Wakamo': ['와카모'], 'Aris': ['아리스'], 'Yuzu': ['유즈'], 'Nagisa': ['나기사']}
INVENTED = re.compile(r'(\d+\s*시에?\s*(약속|만나)|약속은\s*\d|내일\s*\d+시|오늘\s*밤\s*\d+시|\d+시였)')
SENTENCE_SPLIT = re.compile(r'[.!?…]+|\n+')
NORMALIZE = re.compile(r'[\s,.!?…~"\'()\[\]]+')


def sentences(text):
    return [chunk.strip() for chunk in SENTENCE_SPLIT.split(text) if chunk.strip()]


def sentence_bounds(row):
    """캐릭터별 기대 문장 수. 프롬프트 행에 없으면 앱 규칙 기본값(2~4)을 쓴다."""
    bounds = row.get('sentences') or [2, 4]
    return int(bounds[0]), int(bounds[1])


def judge(row, text):
    chunks = sentences(text)
    polite = sum(1 for sentence in chunks if POLITE.search(sentence))
    total = max(len(chunks), 1)
    polite_ratio = polite / total
    register = row['register']
    if register == '존댓말':
        register_ok = polite_ratio >= 0.5
    elif register == '반말':
        register_ok = polite_ratio <= 0.2
    else:
        register_ok = True
    low, high = sentence_bounds(row)
    own_names = NAME_TOKENS.get(row['characterId'], [])
    other_names = [name for names in NAME_TOKENS.values() for name in names if name not in own_names]
    narrator = bool(NARRATOR.search(text)) or any(f'{name}가 ' in text or f'{name}는 ' in text for name in other_names)
    # 선생님을 자기 이름이나 다른 캐릭터 이름으로 부르면 역할 혼동이다(부르는 자리: 문장 시작/쉼표 뒤 + 구두점).
    vocatives = {name for name in own_names + other_names
                 if re.search(rf'(?:^|[,!?…]\s*){re.escape(name)}\s*[,.!?…]', text)}
    identity = bool(vocatives) or any(f'너는 {name}' in text or f'당신은 {name}' in text for name in own_names)
    decoration = DECORATION.search(text)
    # 되풀이: 사용자 메시지를 거의 그대로 되받는 경우만 잡는다(짧은 단어 겹침은 제외).
    normalized_question = NORMALIZE.sub('', row['question'])
    echo = len(normalized_question) >= 6 and normalized_question in NORMALIZE.sub('', text)
    invented = bool(INVENTED.search(text)) if row.get('noInvent') else None
    return {
        'register': {'ok': register_ok, 'polite': polite, 'plain': sum(1 for sentence in chunks if PLAIN.search(sentence)),
                     'ratio': round(polite_ratio, 2), 'expected': register},
        'decoration': {'ok': decoration is None, 'match': decoration.group(0) if decoration else None},
        'sentences': {'ok': low <= len(chunks) <= high, 'count': len(chunks),
                      'too_short': len(chunks) < low, 'too_long': len(chunks) > high,
                      'range': [low, high]},
        'narrator': {'ok': not narrator},
        'identity': {'ok': not identity, 'vocatives': sorted(vocatives)},
        'echo': {'ok': not echo},
        'invented': {'ok': not invented, 'skipped': invented is None},
    }


def judgment(row, text):
    metrics = judge(row, text)
    return {'metrics': metrics,
            'failed': [name for name, metric in metrics.items() if not metric['ok'] and not metric.get('skipped')]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prompts', type=Path, default=Path('runs/voice-probe/prompts.jsonl'))
    parser.add_argument('--out', type=Path, default=None)
    parser.add_argument('--model', default='Qwen/Qwen3-1.7B')
    parser.add_argument('--revision', default='70d244cc86ccca08cf5af4e1e306ecf908b1ad5e')
    parser.add_argument('--device', default='mps')
    parser.add_argument('--adapter', type=Path, default=None)
    parser.add_argument('--filter', default=None, help='선택: id에 이 문자열이 포함된 프롬프트만')
    parser.add_argument('--characters', default=None, help='선택: 쉼표로 구분한 캐릭터 id만')
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--max-new-tokens', type=int, default=128)
    parser.add_argument('--samples', type=int, default=1, help='프롬프트마다 생성할 표본 수(시드 42+i). 잡음이 큰 비교에는 3 이상')
    parser.add_argument('--compare', nargs=2, metavar=('BEFORE_DIR', 'AFTER_DIR'),
                        help='모델 없이 저장된 responses.jsonl 두 개를 지표별 실패율로 비교한다')
    parser.add_argument('--rejudge', action='store_true',
                        help='모델을 돌리지 않고 저장된 responses.jsonl을 현재 지표로 다시 채점한다(프롬프트와 id로 결합).')
    args = parser.parse_args()

    if args.compare:
        before = read_prompts(Path(args.compare[0]) / 'responses.jsonl')
        after = read_prompts(Path(args.compare[1]) / 'responses.jsonl')
        report = compare_reports(args.compare[0], before, args.compare[1], after)
        print(report)
        (Path(args.compare[1]) / 'compare.md').write_text(report + '\n', encoding='utf-8')
        return

    if args.rejudge:
        responses = args.out or args.prompts.parent
        rows = rejudge_records(responses, read_prompts(args.prompts), judgment)
        write_report(responses, rows, rejudged=True)
        print('재채점 완료:', responses / 'summary.md')
        return

    rows = filter_prompts(read_prompts(args.prompts), args.filter, args.limit)
    if args.characters:
        wanted = {name.strip() for name in args.characters.split(',') if name.strip()}
        rows = [row for row in rows if row['characterId'] in wanted]
        if not rows:
            raise SystemExit('선택한 캐릭터의 프롬프트가 없습니다.')
    config = generation_settings(args)
    model, tokenizer = load_probe_model(args.model, args.revision, args.adapter, args.device)
    out_dir = args.out or args.prompts.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    responses = out_dir / 'responses.jsonl'
    records_seen = []
    total = len(rows) * args.samples
    done = 0
    with responses.open('w', encoding='utf-8') as handle:
        for row in rows:
            digest = prompt_digest(row['messages'])
            for sample in range(args.samples):
                seed = SEED + sample
                text, prompt_tokens, seconds, hit_limit = generate(model, tokenizer, row['messages'], args.device,
                                                                   args.max_new_tokens, seed=seed)
                record = {'id': row['id'], 'characterId': row['characterId'], 'register': row['register'], 'questionId': row['questionId'],
                          'sample': sample, 'question': row['question'], 'promptChars': row['promptChars'], 'promptTokens': prompt_tokens,
                          'response': text, 'hit_token_limit': hit_limit, 'seconds': seconds,
                          'seed': seed, 'generation': config, 'prompt_sha256': digest, **judgment(row, text)}
                handle.write(json.dumps(record, ensure_ascii=False) + '\n')
                handle.flush()
                records_seen.append(record)
                done += 1
                failed = record['failed']
                print(f"[{done}/{total}] {row['id']}#{sample} {'OK' if not failed else ','.join(failed)} ({seconds}s)", flush=True)

    write_report(out_dir, records_seen)
    print('저장:', responses, out_dir / 'summary.md')


METRICS = ['register', 'decoration', 'sentences', 'narrator', 'identity', 'echo', 'invented']


def rates(rows, name):
    eligible = [row['metrics'][name] for row in rows if not row['metrics'][name].get('skipped')]
    return sum(not item['ok'] for item in eligible), len(eligible)


def percentage(count, judged):
    return f'{count / judged:.0%}' if judged else '—'


def sample_set(rows):
    if not rows:
        raise ValueError('cannot compare an empty report')
    ids = set()
    seeds = set()
    pairs = {}
    for row in rows:
        key = row['characterId'], row['questionId'], row['sample']
        row_id = row['id'], row['sample']
        if type(row['sample']) is not int or row['sample'] < 0:
            raise ValueError(f'invalid sample index: {key}')
        if key in pairs or row_id in ids:
            raise ValueError(f'duplicate sample: {key}')
        if type(row.get('seed')) is not int:
            raise ValueError(f'{key}: missing recorded generation seed')
        draw = row['id'], row['seed']
        if draw in seeds:
            raise ValueError(f'duplicate seeded draw: {draw}')
        seeds.add(draw)
        ids.add(row_id)
        pairs[key] = (row['id'], row['question'], row['seed'])
    return pairs


def compare_reports(label_before, before, label_after, after):
    if sample_set(before) != sample_set(after):
        raise ValueError('different question/sample sets or seeds; select identical cohorts before comparing')
    lines = ['# 말투 프로브 비교', '', f'- 이전: `{label_before}` ({len(before)}건)',
             *generation_lines(before), '', f'- 이후: `{label_after}` ({len(after)}건)', *generation_lines(after), '',
             '| 지표 | 이전 실패/판정 | 이후 실패/판정 | 이전 비율 | 이후 비율 |', '|---|---:|---:|---:|---:|']
    for name in METRICS:
        a, n = rates(before, name)
        b, m = rates(after, name)
        lines.append(f'| {name} | {a}/{n} | {b}/{m} | {percentage(a, n)} | {percentage(b, m)} |')
    n = len(before)
    a, b = (sum(bool(row['failed']) for row in group) for group in (before, after))
    lines.append(f'| 한 지표 이상 실패 | {a}/{n} | {b}/{n} | {percentage(a, n)} | {percentage(b, n)} |')
    lines += ['', '한두 건 차이는 표본 잡음일 수 있다. 지표율과 원문 답변을 함께 보고 판단한다.']
    return '\n'.join(lines)


def write_report(out_dir, rows, rejudged=False):
    totals = {}
    for record in rows:
        bucket = totals.setdefault(record['characterId'], {'n': 0, 'clean': 0, 'fails': {}, 'seconds': 0.0})
        bucket['n'] += 1
        bucket['clean'] += int(not record['failed'])
        bucket['seconds'] += record.get('seconds', 0)
        for name in record['failed']:
            bucket['fails'][name] = bucket['fails'].get(name, 0) + 1
    lines = ['# 말투 프로브 결과', '',
             ('재채점: 저장된 답변을 현재 지표로 다시 채점' if rejudged else '새 생성'), '',
             *generation_lines(rows),
             '- 프롬프트: 앱의 `chatMessagesFor()`가 조립한 카드+예시(실제 대사)+질문',
             '- 판정은 휴리스틱이다. `sentences`는 캐릭터별 기대 범위(예시 리듬에서 파생)와 비교한다. '
             '원문 답변(`responses.jsonl`)을 함께 보고 판단한다. 앱 모델(Gemma 4 LiteRT) 결과가 아니다.', '',
             '| 캐릭터 | 건수 | 전부 통과 | 실패 지표 | 평균 초 |', '|---|---:|---:|---|---:|']
    for character, bucket in totals.items():
        fails = ', '.join(f'{name} {count}' for name, count in sorted(bucket['fails'].items())) or '—'
        lines.append(f"| {character} | {bucket['n']} | {bucket['clean']} | {fails} | {bucket['seconds'] / bucket['n']:.1f} |")
    lines += ['', '## 지표별 실패 수', '', '| 지표 | 실패 | 판정 수 | 실패율 |', '|---|---:|---:|---:|']
    for name in METRICS:
        count, judged = rates(rows, name)
        lines.append(f'| {name} | {count} | {judged} | {percentage(count, judged)} |')
    lines += ['', '## 답변', '']
    for record in rows:
        lines.append(f"### {record['id']}#{record.get('sample', 0)} ({record['metrics']['register']['expected']})"
                     + (f" 실패: {', '.join(record['failed'])}" if record['failed'] else ' 통과'))
        lines.append(f"- 질문: {record['question']}")
        lines.append(f"- 답변: {record['response']}")
        lines.append('')
    (out_dir / 'summary.md').write_text('\n'.join(lines), encoding='utf-8')


if __name__ == '__main__':
    main()
