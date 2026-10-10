#!/usr/bin/env python3
"""프로브 공통: 로컬 모델 로딩과 생성. memory_probe/voice_probe가 함께 쓴다.

앱의 실제 모델(Gemma 4 LiteRT)이 아니라 로컬 가중치(Qwen3)를 쓰는 프롬프트 수준 검증 도구다.
"""
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
