#!/usr/bin/env python3
"""기억 프로브: 앱이 조립한 프롬프트(카드+예시+참고 자료+질문)를 로컬 Qwen3로 실행한다.

목적은 프롬프트 구조의 검증이다. 앱의 실제 모델(Gemma 4 LiteRT)이 아니라 로컬 Qwen3-1.7B를 쓰므로
이 결과를 앱 품질 보장으로 주장하지 않는다. 앱과 같은 조립 코드는
training/lora/build_memory_probes.ts가 만든 prompts.jsonl에 들어 있다.

    node training/lora/build_memory_probes.ts training/lora/runs/memory-probe/prompts.jsonl
    cd training/lora && uv run --locked python memory_probe.py
"""
import argparse
import json
import re
from collections import Counter
from pathlib import Path

from probe_common import (
    SEED, filter_prompts, generate, generation_lines, generation_settings,
    load_probe_model, prompt_digest, read_prompts, rejudge_records,
)

OUTCOMES = ('correct', 'contradicted', 'unsupported-value', 'unknown')
# Each fixture asks for a numeric value with a specific unit, never a noun
# copied from the question. Accept common Korean counters as well as digits.
NUMBER_WORDS = {'영': 0, '공': 0, '열': 10, '스무': 20}
for i, (native, sino) in enumerate(zip(
        '한 두 세 네 다섯 여섯 일곱 여덟 아홉'.split(), '일이삼사오육칠팔구'), 1):
    NUMBER_WORDS.update({native: i, '열' + native: 10 + i, sino: i, '십' + sino: 10 + i})
NUMBER_WORDS['십'] = 10
NUMERAL = '|'.join(sorted(NUMBER_WORDS, key=len, reverse=True))
UNSURE = re.compile(r'모르|모름|몰라|몰랐|모릅|기억(?:이|은|나지)?\s*(?:안|없|않)|확실하지|확신할 수 없|알 수 없|글쎄|아마|어쩌면|혹시|일까|인지|일지도|같아|같아요')
QUESTION = re.compile(r'[?？]|(?:까|나요|가요|는지|면 좋겠|으면 좋겠)')
NEGATED = re.compile(r'^(?:[은는이가을를도]\s*)?(?:아니|아닌|아닙|아냐|아님|말고|안\s|못\s)|^[^.!?…,\d]{0,12}지\s*않')
SEAT_LABEL = re.compile(r'^(?:좌석|자리)(?=[은는이가을를도\s]|$)\s*')


def score(row, text):
    expect = row['expect']
    if not {'unit', 'value', 'available'} <= expect.keys():
        raise ValueError('legacy keyword expectations cannot measure recall; rebuild prompts and generate new responses')
    unit = re.escape(expect['unit'])
    if expect['unit'] == '잔':
        unit = r'(?:잔|컵)'
    matches = list(re.finditer(rf'(?<![\d.가-힣])(-?\d+(?:\.\d+)?|{NUMERAL})\s*{unit}', text))
    # A bare numeric answer is also unambiguous for a single-slot question.
    if not matches:
        bare = re.fullmatch(r'\s*(-?\d+(?:\.\d+)?)(?:입니다|이요|요)?[.!]?\s*', text)
        matches = [bare] if bare else []
    asserted, denied = set(), set()
    for index, match in enumerate(matches):
        token = match[1]
        value = NUMBER_WORDS[token] if token in NUMBER_WORDS else float(token)
        start = matches[index - 1].end() if index else 0
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        prefix = re.split(r'[.!?…。,\n]', text[start:match.start()])[-1]
        suffix = re.split(r'[.!…。,\n]', text[match.end():end], maxsplit=1)[0].lstrip()
        # 이번 ('this time') is not a claim that the seat number was 2.
        if match.group() == '이번' or UNSURE.search(prefix) or UNSURE.search(suffix) or QUESTION.search(suffix):
            continue
        # The counter can be followed by the slot noun and its particle.
        if expect['unit'] == '번':
            suffix = SEAT_LABEL.sub('', suffix, count=1)
        (denied if NEGATED.search(suffix) else asserted).add(value)
    expected = expect['value']
    if not asserted and not denied:
        outcome, reason = 'unknown', 'no asserted slot value'
    elif not expect['available']:
        outcome, reason = 'unsupported-value', 'value claim without prompt evidence'
    elif expected in denied or asserted - {expected}:
        outcome, reason = 'contradicted', 'denied source value or asserted conflicting value'
    elif asserted == {expected}:
        outcome, reason = 'correct', 'asserted source value'
    else:
        outcome, reason = 'unknown', 'did not identify the source value'
    return {'outcome': outcome, 'reason': reason, 'asserted': sorted(asserted), 'denied': sorted(denied)}


def write_summary(out_dir, records, rejudged=False):
    totals = {}
    for record in records:
        bucket = totals.setdefault(record['variant'], Counter())
        bucket[record['outcome']] += 1
        bucket['n'] += 1
        bucket['truncated'] += int(record.get('hit_token_limit') is True)
    lines = ['# 기억 프로브 결과', '',
             ('재채점: 저장된 답변을 현재 기대값으로 다시 채점' if rejudged else '새 생성'), '',
             *generation_lines(records),
             '- 근거가 있을 때만 일치한 값을 correct로 센다. 근거 없는 값 단정은 우연히 맞아도 unsupported-value다.',
             '- unknown에는 모른다는 답과 해석할 수 없는 답이 모두 포함된다. 이 규칙은 원문 의미 검토를 대체하지 않는다.',
             '- 로컬 Qwen 프롬프트 실험이며 앱 모델(Gemma/LiteRT) 품질 검증이 아니다.', '',
             '| 변형 | 건수 | correct | contradicted | unsupported-value | unknown | 토큰 한도 |',
             '|---|---:|---:|---:|---:|---:|---:|']
    for variant, bucket in totals.items():
        counts = ' | '.join(str(bucket[name]) for name in ('n', *OUTCOMES, 'truncated'))
        lines.append(f'| {variant} | {counts} |')
    lines += ['', '## 답변', '']
    for record in records:
        lines.append(f"### {record['id']} ({record['variant']}#{record['sample']}, {record['outcome']})")
        lines.append(f"- 질문: {record['question']}")
        lines.append(f"- 참고: {', '.join(record.get('reference') or []) or '없음'}")
        lines.append(f"- 답변: {record['response']}")
        lines.append('')
    (out_dir / 'summary.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prompts', type=Path, default=Path('runs/memory-probe/prompts.jsonl'))
    parser.add_argument('--out', type=Path, default=None)
    parser.add_argument('--model', default='Qwen/Qwen3-1.7B')
    parser.add_argument('--revision', default='70d244cc86ccca08cf5af4e1e306ecf908b1ad5e')
    parser.add_argument('--device', default='mps')
    parser.add_argument('--adapter', type=Path, default=None, help='선택: PEFT 어댑터 경로(실험용)')
    parser.add_argument('--limit', type=int, default=0, help='선택: 앞에서 N건만 실행')
    parser.add_argument('--samples', type=int, default=1, help='프롬프트마다 생성할 표본 수(시드 42+i)')
    parser.add_argument('--rejudge', action='store_true', help='모델 없이 저장된 responses.jsonl을 현재 기대값으로 다시 채점')
    parser.add_argument('--filter', default=None, help='선택: id에 이 문자열이 포함된 프롬프트만 실행(예: yuuka)')
    parser.add_argument('--max-new-tokens', type=int, default=128)
    args = parser.parse_args()

    rows = filter_prompts(read_prompts(args.prompts), args.filter, args.limit)
    out_dir = args.out or args.prompts.parent
    if args.rejudge:
        rewritten = rejudge_records(out_dir, rows, score)
        write_summary(out_dir, rewritten, rejudged=True)
        print('재채점 완료:', out_dir / 'summary.md')
        return
    config = generation_settings(args)
    model, tokenizer = load_probe_model(args.model, args.revision, args.adapter, args.device)

    out_dir.mkdir(parents=True, exist_ok=True)
    responses = out_dir / 'responses.jsonl'
    summary = out_dir / 'summary.md'
    records_seen = []
    total = len(rows) * args.samples
    done = 0
    with responses.open('w', encoding='utf-8') as handle:
        for row in rows:
            digest = prompt_digest(row['messages'])
            for sample in range(args.samples):
                seed = SEED + sample
                text, prompt_tokens, seconds, hit_limit = generate(
                    model, tokenizer, row['messages'], args.device, args.max_new_tokens, seed=seed)
                record = {'id': row['id'], 'characterId': row['characterId'], 'variant': row['variant'],
                          'sample': sample, 'seed': seed, 'question': row['question'], 'reference': row['reference'],
                          'promptChars': row['promptChars'], 'promptTokens': prompt_tokens, 'prompt_sha256': digest,
                          'response': text, 'hit_token_limit': hit_limit, 'seconds': seconds, 'generation': config,
                          **score(row, text)}
                handle.write(json.dumps(record, ensure_ascii=False) + '\n')
                handle.flush()
                records_seen.append(record)
                done += 1
                print(f"[{done}/{total}] {row['id']}#{sample} {record['outcome']} "
                      f"({seconds}s, {prompt_tokens} tokens)", flush=True)

    write_summary(out_dir, records_seen)
    print('저장:', responses, summary)


if __name__ == '__main__':
    main()
