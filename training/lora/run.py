#!/usr/bin/env python3
"""Single-GPU LoRA pilots: check / validate / train / compare. No cloud provisioning."""
import argparse
from contextlib import nullcontext
import hashlib
from importlib.metadata import version
import json
import math
import os
import time
from pathlib import Path
import platform
import shutil

HERE = Path(__file__).resolve().parent


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    temporary.replace(path)


def sha256(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text(encoding='utf-8').splitlines() if line.strip()]


def load_data(directory, character):
    manifest = read_json(directory / 'manifest.json')
    for filename, expected in manifest['files'].items():
        if sha256(directory / filename) != expected:
            raise ValueError(f'Dataset changed: {filename}. Regenerate with prepare.py first.')
    card = read_json(directory / 'cards.json')['cards'][character]
    splits = [read_jsonl(directory / f'{character}.{split}.jsonl') for split in ('train', 'eval')]
    if not all(splits):
        raise ValueError('Empty train/eval split')
    if {r['episode'] for r in splits[0]} & {r['episode'] for r in splits[1]}:
        raise ValueError('Train/eval episode leakage')
    if any(r['character'] != character for rows in splits for r in rows):
        raise ValueError('Mixed characters in dataset')
    return card, splits


def messages_for(record, card):
    messages = record['messages']
    if len(messages) < 2 or [m['role'] for m in messages[-2:]] != ['user', 'assistant']:
        raise ValueError(f'{record["id"]}: expected user/assistant ending')
    if any(m['role'] not in ('user', 'assistant') or not m['content'].strip() for m in messages):
        raise ValueError(f'{record["id"]}: invalid conversation')
    return [{'role': 'system', 'content': card['system']}, *messages]


def encode_sample(tokenizer, record, card, max_length):
    """Train ONLY the final assistant reply, including EOS. Mask system, history, thinking prefix.

    Compare token prefixes rather than guessing text lengths or special-token counts.
    Qwen3's pinned non-thinking template must match generation exactly. Fail on drift.
    """
    messages = messages_for(record, card)
    prefix = tokenizer.apply_chat_template(messages[:-1], tokenize=True, add_generation_prompt=True, enable_thinking=False)
    full = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=False, enable_thinking=False)
    if full[:len(prefix)] != prefix or len(full) <= len(prefix):
        raise ValueError(f'{record["id"]}: chat-template prefix mismatch / empty target')
    if len(full) > max_length:
        raise ValueError(f'{record["id"]}: {len(full)} tokens > {max_length}; review context, no silent truncation')
    if tokenizer.eos_token_id not in full[len(prefix):]:
        raise ValueError(f'{record["id"]}: target missing EOS')
    return {'input_ids': full, 'attention_mask': [1] * len(full),
            'labels': [-100] * len(prefix) + full[len(prefix):]}


def tokenizer_for(config):
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(config['base_model'], revision=config['revision'], trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = 'right'
    return tokenizer


def gpu_info(device='auto'):
    import torch
    if int(os.environ.get('WORLD_SIZE', '1')) != 1:
        raise RuntimeError('Single-process training only; no torchrun.')
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'mps'
    if device == 'cuda' and torch.cuda.is_available():
        if torch.cuda.device_count() != 1:
            raise RuntimeError('Use CUDA_VISIBLE_DEVICES=0 (or another single GPU).')
        prop = torch.cuda.get_device_properties(0)
        return {'device': 'cuda:0', 'name': prop.name, 'vram_gib': round(prop.total_memory / 2**30, 2),
                'cuda': torch.version.cuda, 'bf16': torch.cuda.is_bf16_supported()}
    if device == 'mps' and torch.backends.mps.is_available():
        try:
            probe = torch.ones(2, 2, device='mps', dtype=torch.bfloat16)
            (probe @ probe).sum().item()
            bf16 = True
        except (RuntimeError, TypeError):
            bf16 = False
        return {'device': 'mps', 'name': 'Apple Metal', 'bf16': bf16,
                'recommended_memory_gib': round(torch.mps.recommended_max_memory() / 2**30, 2)}
    raise RuntimeError(f'{device} GPU not found; CPU is only supported by the offline unit tests.')


def load_model(config, qlora=False, device='auto'):
    import torch
    from transformers import AutoModelForCausalLM, BitsAndBytesConfig
    info = gpu_info(device)  # No unnoticed CPU training/offload or paid provisioning.
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    if info['device'] == 'mps':
        # Keep the driver's memory guard; do not disable high-watermark protection.
        torch.mps.set_per_process_memory_fraction(0.7)
    dtype = torch.bfloat16 if info['bf16'] else (torch.float32 if info['device'] == 'mps' else torch.float16)
    kwargs = {'revision': config['revision'], 'trust_remote_code': False,
              'use_safetensors': True, 'torch_dtype': dtype, 'attn_implementation': 'sdpa'}
    if qlora:
        if info['device'] != 'cuda:0' or platform.system() != 'Linux':
            raise RuntimeError('QLoRA requires Linux/WSL2 NVIDIA; use regular LoRA on MPS.')
        try:
            version('bitsandbytes')
        except Exception as exc:
            raise RuntimeError('Install QLoRA extra: uv sync --locked --extra qlora') from exc
        kwargs.update(device_map={'': 0}, quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=dtype))
    model = AutoModelForCausalLM.from_pretrained(config['base_model'], **kwargs)
    return model if qlora else model.to(info['device'])


def add_lora(model, config, qlora=False):
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    if qlora:
        model = prepare_model_for_kbit_training(model, gradient_checkpointing_kwargs={'use_reentrant': False})
    model.config.use_cache = False
    return get_peft_model(model, LoraConfig(
        task_type='CAUSAL_LM', r=config['lora_r'], lora_alpha=config['lora_alpha'],
        lora_dropout=config['lora_dropout'], bias='none', target_modules=config['target_modules'],
        revision=config['revision']))


def reply_loss_inputs(inputs):
    """Keep all attention context, but project only logits needed by non-masked labels.

    Include the position BEFORE the first target because causal loss shifts labels.
    Slicing labels by the same amount preserves the ordinary HF causal loss exactly,
    including right-padding and gradient-accumulation token counts.
    """
    labels = inputs['labels']
    positions = (labels != -100).nonzero(as_tuple=True)[1]
    if not positions.numel():
        raise ValueError('No supervised reply tokens')
    keep = min(labels.shape[1], labels.shape[1] - int(positions.min().item()) + 1)
    return {**inputs, 'labels': labels[:, -keep:], 'logits_to_keep': keep}


# Files consumed when resuming this single-process PEFT Trainer (not the inference export).
CHECKPOINT_FILES = ('trainer_state.json', 'adapter_config.json', 'adapter_model.safetensors',
                    'optimizer.pt', 'scheduler.pt', 'rng_state.pth')


def latest_complete_checkpoint(directory):
    candidates = ((int(step), p) for p in directory.glob('checkpoint-*')
                  if (step := p.name.removeprefix('checkpoint-')).isascii() and step.isdecimal() and p.is_dir())
    for step, path in sorted(candidates, reverse=True):
        try:
            files = read_json(path / 'complete.json')
            if (not isinstance(files, dict) or not set(CHECKPOINT_FILES) <= files.keys()
                    or files.keys() - {*CHECKPOINT_FILES, 'scaler.pt'}):
                continue
            state = read_json(path / 'trainer_state.json')
            if not isinstance(state, dict) or state.get('global_step') != step:
                continue
            if all(sha256(path / name) == digest for name, digest in files.items()):
                return path
        except (FileNotFoundError, IsADirectoryError, ValueError):
            continue  # Interrupted save or corrupt file: try the previous epoch.
    raise ValueError('No complete checkpoint to resume. Preserve this run and start with a new --out.')


def trainer_for(model, tokenizer, train, evaluation, config, output, max_steps=-1, use_cpu=False):
    import torch
    from transformers import Trainer, TrainerCallback, TrainingArguments, DataCollatorForSeq2Seq
    if model.config.model_type != 'qwen3':
        raise ValueError('Reply-only logits optimization is validated for Qwen3 only')

    class ReplyTrainer(Trainer):
        def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
            return super().compute_loss(model, reply_loss_inputs(inputs), return_outputs=return_outputs,
                                        num_items_in_batch=num_items_in_batch)

    class CheckpointCommit(TrainerCallback):
        def on_save(self, args, state, control, **kwargs):
            path = Path(args.output_dir) / f'checkpoint-{state.global_step}'
            files = (*CHECKPOINT_FILES, 'scaler.pt') if args.fp16 else CHECKPOINT_FILES
            write_json(path / 'complete.json', {name: sha256(path / name) for name in files})

    bf16 = not use_cpu and model.dtype == torch.bfloat16
    args = TrainingArguments(
        output_dir=str(output), num_train_epochs=config['epochs'], max_steps=max_steps,
        per_device_train_batch_size=1, per_device_eval_batch_size=1,
        gradient_accumulation_steps=config['gradient_accumulation_steps'],
        learning_rate=config['learning_rate'], lr_scheduler_type='linear', warmup_ratio=0.1,
        optim='adamw_torch', bf16=bf16, fp16=not use_cpu and model.dtype == torch.float16, use_cpu=use_cpu,
        gradient_checkpointing=True, gradient_checkpointing_kwargs={'use_reentrant': False},
        eval_strategy='epoch', save_strategy='epoch', save_total_limit=2,
        logging_steps=1, report_to='none', seed=config['seed'], data_seed=config['seed'],
        dataloader_num_workers=0, dataloader_pin_memory=not use_cpu and model.device.type == 'cuda',
        label_names=['labels'], disable_tqdm=True,
    )
    return ReplyTrainer(model=model, args=args, train_dataset=train, eval_dataset=evaluation,
                   callbacks=[CheckpointCommit()], processing_class=tokenizer, data_collator=DataCollatorForSeq2Seq(
                       tokenizer, padding=True, label_pad_token_id=-100))


def validate(args):
    config = read_json(args.config)
    tokenizer = tokenizer_for(config)  # Tokenizer only; never downloads base-model weights.
    cards = read_json(args.data / 'cards.json')['cards']
    for character in cards:
        card, splits = load_data(args.data, character)
        for name, records in zip(('train', 'eval'), splits):
            encoded = [encode_sample(tokenizer, r, card, config['max_length']) for r in records]
            lengths = [len(r['input_ids']) for r in encoded]
            targets = [sum(t != -100 for t in r['labels']) for r in encoded]
            print(f'{character} {name}: {len(records)} samples, tokens={min(lengths)}..{max(lengths)}, target={min(targets)}..{max(targets)}')


def train(args):
    from transformers import set_seed
    config = read_json(args.config)
    info = gpu_info(args.device)
    card, splits = load_data(args.data, args.character)
    fingerprint = {'config': config, 'character': args.character, 'qlora': args.qlora, 'device': info['device'],
                   'max_steps': 2 if args.smoke else -1, 'data_sha256': sha256(args.data / 'manifest.json'),
                   'lock_sha256': sha256(HERE / 'uv.lock'), 'code_sha256': sha256(HERE / 'run.py'),
                   'probes_sha256': sha256(HERE / 'probes.json')}
    checkpoint = None
    if args.resume:
        previous = read_json(args.out / 'run.json')
        if previous['fingerprint'] != fingerprint:
            raise ValueError('Resume refused: config/dataset/environment lock changed')
        if previous['status'] == 'completed':
            raise ValueError('Run already completed; choose a new --out')
        checkpoint = str(latest_complete_checkpoint(args.out / 'checkpoints'))
    elif args.out.exists() and any(args.out.iterdir()):
        raise ValueError('Output is non-empty; use a new --out or --resume. Nothing overwritten.')
    set_seed(config['seed'])
    tokenizer = tokenizer_for(config)
    encoded = [[encode_sample(tokenizer, r, card, config['max_length']) for r in rows] for rows in splits]
    args.out.mkdir(parents=True, exist_ok=True)
    record = {'status': 'running', 'fingerprint': fingerprint, 'card': card, 'gpu': info,
              'python': platform.python_version(),
              'packages': {p: version(p) for p in ['torch', 'transformers', 'peft', 'accelerate']},
              'sample_counts': dict(zip(('train', 'eval'), map(len, splits)))}
    if args.qlora:
        record['packages']['bitsandbytes'] = version('bitsandbytes')
    write_json(args.out / 'run.json', record)
    shutil.copyfile(args.data / f'{args.character}.eval.jsonl', args.out / 'eval.jsonl')
    shutil.copyfile(HERE / 'probes.json', args.out / 'probes.json')
    model = add_lora(load_model(config, args.qlora, args.device), config, args.qlora)
    model.print_trainable_parameters()
    trainer = trainer_for(model, tokenizer, *encoded, config, args.out / 'checkpoints', fingerprint['max_steps'])
    with model.disable_adapter():
        baseline = trainer.evaluate()
    record['base_evaluation'] = baseline
    write_json(args.out / 'run.json', record)
    result = trainer.train(resume_from_checkpoint=checkpoint)
    metrics = trainer.evaluate()
    if not all(math.isfinite(x) for x in (baseline['eval_loss'], result.training_loss, metrics['eval_loss'])):
        raise ValueError('Non-finite loss: refusing to publish adapter')
    import torch
    weights = [p.detach() for name, p in model.named_parameters() if 'lora_' in name]
    changed = [p.detach() for name, p in model.named_parameters() if 'lora_B' in name]
    if not weights or not all(torch.isfinite(p).all().item() for p in weights) or not any(torch.count_nonzero(p).item() for p in changed):
        raise ValueError('Adapter is non-finite or was not updated')
    record['adapter_verified'] = {'finite': True, 'updated': True,
                                  'parameters': sum(p.numel() for p in weights)}
    trainer.save_state()
    model.save_pretrained(args.out / 'adapter', safe_serialization=True)
    tokenizer.save_pretrained(args.out / 'adapter')
    write_json(args.out / 'card.json', {**card, 'adapter': {
        'format': 'peft-lora', 'path': 'adapter', 'base_model': config['base_model'], 'revision': config['revision']}})
    artifacts = [args.out / name for name in ('card.json', 'eval.jsonl', 'probes.json')]
    artifacts += sorted((args.out / 'adapter').iterdir())
    record.update(status='completed', training=result.metrics, evaluation=metrics,
                  artifacts={str(p.relative_to(args.out)): sha256(p) for p in artifacts if p.is_file()})
    write_json(args.out / 'run.json', record)
    print(f'Saved adapter + card: {args.out}. Smoke/pilot only; evaluate voice before use.')


def comparison_fields(case, identity, seed):
    return {**case, 'messages': case['messages'][1:], 'seed': seed, 'run_sha256': identity}


def comparison_prefix(path, cases, identity, config, *, partial):
    """Validate committed rows before truncating any uncommitted tail."""
    count = 0
    with path.open('r+b' if partial else 'rb') as handle:
        while True:
            start = handle.tell()
            line = handle.readline()
            if not line:
                break
            if count == len(cases):
                raise ValueError(f'{path}: unexpected extra comparison data')
            if not line.endswith(b'\n'):
                if not partial:
                    raise ValueError(f'{path}: incomplete finalized comparison row')
                handle.truncate(start)
                break
            row = json.loads(line.decode('utf-8'))
            expected = comparison_fields(cases[count], identity, config['seed'])
            if (not isinstance(row, dict) or any(row.get(k) != v for k, v in expected.items())
                    or not isinstance(row.get('device'), str) or not row['device']):
                raise ValueError(f'{path}: invalid comparison prefix at row {count + 1}')
            for label in ('base', 'lora'):
                answer = row.get(label)
                if (not isinstance(answer, dict) or not isinstance(answer.get('text'), str)
                        or type(answer.get('hit_token_limit')) is not bool
                        or type(answer.get('tokens')) is not int or not 0 < answer['tokens'] <= config['max_new_tokens']
                        or type(answer.get('seconds')) not in (int, float)
                        or not math.isfinite(answer['seconds']) or answer['seconds'] < 0):
                    raise ValueError(f'{path}: invalid {label} answer at row {count + 1}')
            count += 1
    return count


def compare(args):
    record = read_json(args.run / 'run.json')
    if record['status'] != 'completed':
        raise ValueError('Run has not completed')
    for filename, expected in record['artifacts'].items():
        if sha256(args.run / filename) != expected:
            raise ValueError(f'Saved artifact changed: {filename}')
    config, card = record['fingerprint']['config'], read_json(args.run / 'card.json')
    if (card['adapter']['base_model'], card['adapter']['revision']) != (config['base_model'], config['revision']):
        raise ValueError('Card / base-model compatibility mismatch')
    output = args.out or args.run / 'comparison.jsonl'
    partial = output.with_name(output.name + '.partial')
    identity = sha256(args.run / 'run.json')
    cases = [{'id': r['id'], 'kind': 'heldout', 'messages': messages_for(r, card)[:-1],
              'reference': r['messages'][-1]['content']} for r in read_jsonl(args.run / 'eval.jsonl')]
    cases += [{'id': p['id'], 'kind': 'probe', 'messages': [
        {'role': 'system', 'content': card['system']}, {'role': 'user', 'content': p['prompt']}]
    } for p in read_json(args.run / 'probes.json')]
    existing = output if output.exists() else partial
    if existing.exists() and not args.resume:
        raise ValueError('Comparison exists; pass --resume or choose another --out')
    count = comparison_prefix(existing, cases, identity, config, partial=existing == partial) if existing.exists() else 0
    if output.exists():
        if count != len(cases):
            raise ValueError('Incomplete finalized comparison')
        print(f'Comparison already complete: {output}')
        return
    if partial.exists() and count == len(cases):
        partial.replace(output)
        print(f'Finalized complete comparison: {output}')
        return
    import torch
    from peft import PeftModel
    from transformers import AutoTokenizer, set_seed
    tokenizer = AutoTokenizer.from_pretrained(args.run / 'adapter', trust_remote_code=False)
    model = PeftModel.from_pretrained(load_model(config, record['fingerprint']['qlora'], args.device), args.run / 'adapter')
    model.eval()
    model.config.use_cache = True
    output.parent.mkdir(parents=True, exist_ok=True)
    with partial.open('a' if partial.exists() else 'x', encoding='utf-8') as handle:
        for case in cases[count:]:
            ids = tokenizer.apply_chat_template(case['messages'], tokenize=True, add_generation_prompt=True, enable_thinking=False)
            if len(ids) + config['max_new_tokens'] > config['max_length']:
                raise ValueError(f'{case["id"]}: exceeds comparison context budget')
            inputs = torch.tensor([ids], device=model.device)
            row = {**comparison_fields(case, identity, config['seed']), 'device': str(model.device)}
            for label in ('base', 'lora'):
                set_seed(config['seed'])
                started = time.monotonic()
                with (model.disable_adapter() if label == 'base' else nullcontext()), torch.inference_mode():
                    generated = model.generate(
                        input_ids=inputs, attention_mask=torch.ones_like(inputs),
                        max_new_tokens=config['max_new_tokens'], do_sample=True,
                        temperature=0.7, top_p=0.8, top_k=20, pad_token_id=tokenizer.pad_token_id,
                        eos_token_id=tokenizer.eos_token_id)[0, len(ids):].tolist()
                row[label] = {'text': tokenizer.decode(generated, skip_special_tokens=True),
                              'tokens': len(generated), 'hit_token_limit': tokenizer.eos_token_id not in generated,
                              'seconds': round(time.monotonic() - started, 3)}
            handle.write(json.dumps(row, ensure_ascii=False) + '\n')
            handle.flush()
            print(f'Compared {case["id"]}', flush=True)
    partial.replace(output)
    print(f'Base vs LoRA (same card, no few-shot): {output}')


def main():
    # Set before importing torch; an explicit single-device choice from the user wins.
    os.environ.setdefault('CUDA_VISIBLE_DEVICES', '0')
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('check', help='Check local CUDA/MPS; no model download')
    p.add_argument('--device', choices=('auto', 'cuda', 'mps'), default='auto')
    p = commands.add_parser('validate', help='Download tokenizer only; verify masks and real token lengths')
    p.add_argument('--config', type=Path, default=HERE / 'pilot.json')
    p.add_argument('--data', type=Path, default=HERE / 'data')
    p = commands.add_parser('train', help='Train ONE character; loop externally for three pilots')
    p.add_argument('--config', type=Path, default=HERE / 'pilot.json')
    p.add_argument('--data', type=Path, default=HERE / 'data')
    p.add_argument('--character', required=True, choices=('Yuuka', 'CH0069', 'Aris'))
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--smoke', action='store_true', help='Two optimizer steps, not a quality run')
    p.add_argument('--qlora', action='store_true', help='Optional NF4 base quantization (requires extra)')
    p.add_argument('--resume', action='store_true', help='Resume latest checkpoint in the SAME output/config/data')
    p.add_argument('--device', choices=('auto', 'cuda', 'mps'), default='auto')
    p = commands.add_parser('compare', help='Load saved card+adapter; compare against its exact base model')
    p.add_argument('--run', required=True, type=Path)
    p.add_argument('--out', type=Path)
    p.add_argument('--device', choices=('auto', 'cuda', 'mps'), default='auto')
    p.add_argument('--resume', action='store_true', help='Continue a validated partial comparison')
    args = parser.parse_args()
    if args.command == 'check':
        print(json.dumps(gpu_info(args.device), ensure_ascii=False, indent=2))
    else:
        {'validate': validate, 'train': train, 'compare': compare}[args.command](args)


if __name__ == '__main__':
    main()
