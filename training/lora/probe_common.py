#!/usr/bin/env python3
"""프로브 공통: 로컬 모델 로딩과 생성. memory_probe/voice_probe가 함께 쓴다.

앱의 실제 모델(Gemma 4 LiteRT)이 아니라 로컬 가중치(Qwen3)를 쓰는 프롬프트 수준 검증 도구다.
"""
import hashlib
import json
import time
from pathlib import Path

# 앱이 Worker에 넘기는 샘플링 설정과 맞춘다(src/workers/local-ai.worker.ts).
SEED = 42
TEMPERATURE = 0.6
TOP_P = 0.9


def read_prompts(path):
    return [json.loads(line) for line in Path(path).read_text(encoding='utf-8').splitlines() if line.strip()]


def filter_prompts(rows, needle=None, limit=0):
    if needle:
        rows = [row for row in rows if needle in row['id']]
    if limit:
        rows = rows[:limit]
    if not rows:
        raise SystemExit('조건에 맞는 프롬프트가 없습니다.')
    return rows


def generation_settings(args):
    if args.samples < 1 or args.max_new_tokens < 1:
        raise SystemExit('--samples and --max-new-tokens must be positive')
    return {
        'model': args.model, 'revision': args.revision, 'device': args.device,
        'adapter': str(args.adapter) if args.adapter else None,
        'samples': args.samples, 'max_new_tokens': args.max_new_tokens,
        'temperature': TEMPERATURE, 'top_p': TOP_P,
    }


def prompt_digest(messages):
    payload = json.dumps(messages, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(payload.encode()).hexdigest()


def generation_lines(records):
    """Describe only generation facts saved with the outputs, never CLI defaults."""
    configs = {json.dumps(r.get('generation'), sort_keys=True) for r in records}
    if len(configs) != 1 or 'null' in configs:
        lines = ['- 생성 조건: 미기록 또는 혼합 (현재 CLI 기본값으로 추정하지 않음)']
        adapters = sorted({str(r['adapter']) for r in records if 'adapter' in r})
        if adapters:
            lines.append(f'- 구판 응답에 기록된 어댑터: {", ".join(adapters)}')
        return lines
    config = json.loads(configs.pop())
    seeds = ', '.join(str(s) for s in sorted({r['seed'] for r in records}))
    return [
        f'- 모델: `{config["model"]}` @ `{config["revision"]}`, 어댑터: `{config["adapter"]}`, 장치: `{config["device"]}`',
        f'- 생성 설정: 프롬프트당 {config["samples"]}표본, 관측 seed {seeds}, temperature {config["temperature"]}, '
        f'top_p {config["top_p"]}, 최대 {config["max_new_tokens"]}토큰',
    ]


def rejudge_records(out_dir, prompts, judge):
    """Update only judging fields and commit only after every join succeeds."""
    sources = {row['id']: row for row in prompts}
    if len(sources) != len(prompts):
        raise ValueError('duplicate prompt ID')
    path = out_dir / 'responses.jsonl'
    records = read_prompts(path)
    if not records:
        raise ValueError('no responses to rejudge')
    keys = set()
    for record in records:
        key = record['id'], record.get('sample', 0)
        if key in keys:
            raise ValueError(f'duplicate sample: {key}')
        keys.add(key)
        row = sources.get(record['id'])
        if not row or row['question'] != record['question'] or row['characterId'] != record['characterId']:
            raise ValueError(f'{key}: different question or missing prompt')
        if 'prompt_sha256' in record and record['prompt_sha256'] != prompt_digest(row['messages']):
            raise ValueError(f'{key}: different generation prompt')
        record.update(judge(row, record['response']))
    temp = path.with_suffix('.tmp')
    temp.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records), encoding='utf-8')
    temp.replace(path)
    return records


def load_probe_model(model_id, revision, adapter=None, device='mps'):
    """(model, tokenizer)를 돌려준다. torch를 import하므로 호출이 늦어야 한다."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(model_id, revision=revision)
    model = AutoModelForCausalLM.from_pretrained(model_id, revision=revision, dtype=torch.bfloat16)
    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter)
    model = model.to(device).eval()
    model.config.use_cache = True
    return model, tokenizer


def generate(model, tokenizer, messages, device='mps', max_new_tokens=128, seed=None):
    """앱과 같은 채팅 템플릿·샘플링으로 한 번 생성한다. (text, prompt_tokens, seconds, hit_limit)를 돌려준다.

    같은 조건을 여러 번 뽑을 때는 seed를 바꿔 표본을 늘린다(작은 모델은 한 번의 결과로 비교하면 잡음에 속는다).
    """
    import torch
    from transformers import set_seed

    ids = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, enable_thinking=False)
    inputs = torch.tensor([ids], device=device)
    set_seed(SEED if seed is None else seed)
    started = time.monotonic()
    with torch.inference_mode():
        generated = model.generate(
            input_ids=inputs, attention_mask=torch.ones_like(inputs), max_new_tokens=max_new_tokens,
            do_sample=True, temperature=TEMPERATURE, top_p=TOP_P, pad_token_id=tokenizer.pad_token_id,
            eos_token_id=tokenizer.eos_token_id)[0, len(ids):].tolist()
    text = tokenizer.decode(generated, skip_special_tokens=True).strip()
    return text, len(ids), round(time.monotonic() - started, 2), tokenizer.eos_token_id not in generated
