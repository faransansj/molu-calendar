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
from pathlib import Path

from probe_common import SEED, TEMPERATURE, TOP_P, filter_prompts, generate, load_probe_model, read_prompts


def score(row, text):
    includes = row['expect'].get('includes') or []
    excludes = row['expect'].get('excludes') or []
    hit = any(keyword in text for keyword in includes) if includes else None
    leaked = any(keyword in text for keyword in excludes) if excludes else None
    return hit, leaked


def write_summary(out_dir, records, args, rejudged_from=None):
    totals = {}
    for record in records:
        bucket = totals.setdefault(record['variant'], {'n': 0, 'hit': 0, 'leak': 0, 'truncated': 0, 'seconds': 0.0})
        bucket['n'] += 1
        bucket['hit'] += int(record['hit'] is True)
        bucket['leak'] += int(record['leaked'] is True)
        bucket['truncated'] += int(record.get('hit_token_limit') is True)
        bucket['seconds'] += record.get('seconds', 0)
    lines = ['# 기억 프로브 결과', '',
             ('재채점: 저장된 답변을 현재 기대값으로 다시 채점' if rejudged_from else '새 생성'), '',
             f'- 모델: `{args.model}` @ `{args.revision}`' + (f' + 어댑터 `{args.adapter}`' if args.adapter else ''),
             f'- 장치: `{args.device}`, 샘플링: seed {SEED}, temperature {TEMPERATURE}, top_p {TOP_P}, 최대 {args.max_new_tokens}토큰',
             '- 프롬프트: 앱의 `chatMessagesWithReferences()`가 조립한 카드+예시+참고 자료+질문',
             '- 이 결과는 프롬프트 구조 검증이며, 앱 모델(Gemma 4 LiteRT)의 품질 보장이 아니다.', '',
             '| 변형 | 건수 | 기억 반영(hit) | 유출/환각(leak) | 토큰 한도 도달 | 평균 초 |',
             '|---|---:|---:|---:|---:|---:|']
    for variant, bucket in totals.items():
        lines.append(f"| {variant} | {bucket['n']} | {bucket['hit']} | {bucket['leak']} | {bucket['truncated']} | {bucket['seconds'] / bucket['n']:.1f} |")
    lines += ['', '## 답변', '']
    for record in records:
        flag = '기대 충족' if record['hit'] else '기대 위반' if record['leaked'] else '중립'
        lines.append(f"### {record['id']} ({record['variant']}#{record.get('sample', 0)}, {flag})")
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
        sources = {row['id']: row for row in rows}
        rewritten = []
        for line in (out_dir / 'responses.jsonl').read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            source = sources.get(record['id'])
            if not source:
                raise SystemExit(f'{record["id"]}: 프롬프트를 찾을 수 없습니다.')
            hit, leaked = score(source, record['response'])
            record['hit'], record['leaked'] = hit, leaked
            rewritten.append(record)
        (out_dir / 'responses.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rewritten), encoding='utf-8')
        write_summary(out_dir, rewritten, args, rejudged_from=args.prompts)
        print('재채점 완료:', out_dir / 'summary.md')
        return
    model, tokenizer = load_probe_model(args.model, args.revision, args.adapter, args.device)

    out_dir = args.out or args.prompts.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    responses = out_dir / 'responses.jsonl'
    summary = out_dir / 'summary.md'
    totals = {}
    total = len(rows) * args.samples
    done = 0
    with responses.open('w', encoding='utf-8') as handle:
        for row in rows:
          for sample in range(args.samples):
            text, prompt_tokens, seconds, hit_limit = generate(model, tokenizer, row['messages'], args.device, args.max_new_tokens, seed=42 + sample)
            hit, leaked = score(row, text)
            record = {'id': row['id'], 'characterId': row['characterId'], 'variant': row['variant'], 'sample': sample, 'question': row['question'],
                      'reference': row.get('reference') or ([row['memory']] if row.get('memory') else []),
                      'promptChars': row['promptChars'], 'promptTokens': prompt_tokens,
                      'response': text, 'hit': hit, 'leaked': leaked, 'hit_token_limit': hit_limit,
                      'seconds': seconds, 'adapter': str(args.adapter) if args.adapter else None}
            handle.write(json.dumps(record, ensure_ascii=False) + '\n')
            handle.flush()
            bucket = totals.setdefault(row['variant'], {'n': 0, 'hit': 0, 'leak': 0, 'truncated': 0, 'seconds': 0.0})
            bucket['n'] += 1
            bucket['hit'] += int(hit is True)
            bucket['leak'] += int(leaked is True)
            bucket['truncated'] += int(record['hit_token_limit'])
            bucket['seconds'] += record['seconds']
            done += 1
            print(f"[{done}/{total}] {row['id']}#{sample} {'hit' if hit else 'leak' if leaked else 'miss'} "
                  f"({record['seconds']}s, {prompt_tokens} tokens)", flush=True)

    write_summary(out_dir, records_seen, args)
    print('저장:', responses, summary)


if __name__ == '__main__':
    main()
