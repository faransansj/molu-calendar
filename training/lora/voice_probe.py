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

from probe_common import filter_prompts, generate, load_probe_model, read_prompts

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
        before = [json.loads(line) for line in (Path(args.compare[0]) / 'responses.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()]
        after = [json.loads(line) for line in (Path(args.compare[1]) / 'responses.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()]
        report = compare_reports(args.compare[0], before, args.compare[1], after)
        print(report)
        (Path(args.compare[1]) / 'compare.md').write_text(report + '\n', encoding='utf-8')
        return

    if args.rejudge:
        prompts = {row['id']: row for row in read_prompts(args.prompts)}
        responses = args.out or args.prompts.parent
        rows = []
        for line in (responses / 'responses.jsonl').read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            source = prompts.get(record['id'])
            if not source:
                raise SystemExit(f'{record["id"]}: 프롬프트를 찾을 수 없습니다.')
            metrics = judge(source, record['response'])
            record['metrics'] = metrics
            record['failed'] = [name for name, value in metrics.items() if not value['ok'] and not value.get('skipped')]
            rows.append(record)
        (responses / 'responses.jsonl').write_text(''.join(json.dumps(record, ensure_ascii=False) + '\n' for record in rows), encoding='utf-8')
        write_report(responses, rows, args, rejudged_from=args.prompts)
        print('재채점 완료:', responses / 'summary.md')
        return

    rows = filter_prompts(read_prompts(args.prompts), args.filter, args.limit)
    if args.characters:
        wanted = {name.strip() for name in args.characters.split(',') if name.strip()}
        rows = [row for row in rows if row['characterId'] in wanted]
        if not rows:
            raise SystemExit('선택한 캐릭터의 프롬프트가 없습니다.')
    model, tokenizer = load_probe_model(args.model, args.revision, args.adapter, args.device)
    out_dir = args.out or args.prompts.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    responses = out_dir / 'responses.jsonl'
    records_seen = []
    total = len(rows) * args.samples
    done = 0
    with responses.open('w', encoding='utf-8') as handle:
        for row in rows:
            for sample in range(args.samples):
                text, prompt_tokens, seconds, hit_limit = generate(model, tokenizer, row['messages'], args.device,
                                                                   args.max_new_tokens, seed=42 + sample)
                metrics = judge(row, text)
                failed = [name for name, value in metrics.items() if not value['ok'] and not value.get('skipped')]
                record = {'id': row['id'], 'characterId': row['characterId'], 'register': row['register'], 'questionId': row['questionId'],
                          'sample': sample, 'question': row['question'], 'promptChars': row['promptChars'], 'promptTokens': prompt_tokens,
                          'response': text, 'metrics': metrics, 'failed': failed, 'hit_token_limit': hit_limit, 'seconds': seconds,
                          'adapter': str(args.adapter) if args.adapter else None}
                handle.write(json.dumps(record, ensure_ascii=False) + '\n')
                handle.flush()
                records_seen.append(record)
                done += 1
                print(f"[{done}/{total}] {row['id']}#{sample} {'OK' if not failed else ','.join(failed)} ({seconds}s)", flush=True)

    write_report(out_dir, records_seen, args)
    print('저장:', responses, out_dir / 'summary.md')


METRICS = ['register', 'decoration', 'sentences', 'narrator', 'identity', 'echo', 'invented']


def rates(rows):
    judged = len(rows)
    return {name: sum(1 for row in rows if not row['metrics'].get(name, {'ok': True})['ok'] and not row['metrics'].get(name, {}).get('skipped'))
            for name in METRICS} | {'judged': judged, 'clean': sum(1 for row in rows if not row['failed'])}


def compare_reports(label_before, before, label_after, after):
    left, right = rates(before), rates(after)
    lines = ['# 말투 프로브 비교', '', f'- 이전: `{label_before}` ({left["judged"]}건)',
             f'- 이후: `{label_after}` ({right["judged"]}건)', '',
             '| 지표 | 이전 실패 | 이후 실패 | 이전 비율 | 이후 비율 |', '|---|---:|---:|---:|---:|']
    for name in METRICS:
        lines.append(f'| {name} | {left[name]} | {right[name]} | {left[name] / max(left["judged"], 1):.0%} | {right[name] / max(right["judged"], 1):.0%} |')
    lines.append(f'| 전부 통과 | {left["judged"] - left["clean"]} 실패 | {right["judged"] - right["clean"]} 실패 | '
                 f'{1 - left["clean"] / max(left["judged"], 1):.0%} | {1 - right["clean"] / max(right["judged"], 1):.0%} |')
    lines += ['', '한두 건 차이는 표본 잡음일 수 있다. 지표율과 원문 답변을 함께 보고 판단한다.']
    return '\n'.join(lines)


def write_report(out_dir, rows, args, rejudged_from=None):
    totals = {}
    for record in rows:
        bucket = totals.setdefault(record['characterId'], {'n': 0, 'clean': 0, 'fails': {}, 'seconds': 0.0})
        bucket['n'] += 1
        bucket['clean'] += int(not record['failed'])
        bucket['seconds'] += record.get('seconds', 0)
        for name in record['failed']:
            bucket['fails'][name] = bucket['fails'].get(name, 0) + 1
    lines = ['# 말투 프로브 결과', '',
             ('재채점: 저장된 답변을 현재 지표로 다시 채점' if rejudged_from else '새 생성'), '',
             f"- 모델: `{args.model}` @ `{args.revision}`" + (f' + 어댑터 `{args.adapter}`' if args.adapter else ''),
             '- 프롬프트: 앱의 `chatMessagesFor()`가 조립한 카드+예시(실제 대사)+질문',
             f"- 샘플링: seed 42..{41 + args.samples}, temperature 0.6, top_p 0.9, 최대 {args.max_new_tokens}토큰"
             + (f", 프롬프트당 {args.samples}표본" if args.samples > 1 else ''),
             '- 판정은 휴리스틱이다. `sentences`는 캐릭터별 기대 범위(예시 리듬에서 파생)와 비교한다. '
             '원문 답변(`responses.jsonl`)을 함께 보고 판단한다. 앱 모델(Gemma 4 LiteRT) 결과가 아니다.', '',
             '| 캐릭터 | 건수 | 전부 통과 | 실패 지표 | 평균 초 |', '|---|---:|---:|---|---:|']
    for character, bucket in totals.items():
        fails = ', '.join(f'{name} {count}' for name, count in sorted(bucket['fails'].items())) or '—'
        lines.append(f"| {character} | {bucket['n']} | {bucket['clean']} | {fails} | {bucket['seconds'] / bucket['n']:.1f} |")
    overall = {name: sum(bucket['fails'].get(name, 0) for bucket in totals.values())
               for name in ['register', 'decoration', 'sentences', 'narrator', 'identity', 'echo', 'invented']}
    lines += ['', '## 지표별 실패 수', '', '| 지표 | 실패 | 판정 수 | 실패율 |', '|---|---:|---:|---:|']
    judged = sum(bucket['n'] for bucket in totals.values())
    lines += [f'| {name} | {count} | {judged} | {count / judged:.0%} |' for name, count in overall.items()]
    lines += ['', '## 답변', '']
    for record in rows:
        lines.append(f"### {record['id']} ({record['register']})" + (f" 실패: {', '.join(record['failed'])}" if record['failed'] else ' 통과'))
        lines.append(f"- 질문: {record['question']}")
        lines.append(f"- 답변: {record['response']}")
        lines.append('')
    (out_dir / 'summary.md').write_text('\n'.join(lines), encoding='utf-8')


if __name__ == '__main__':
    main()
