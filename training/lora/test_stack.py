"""Offline CPU integration: tiny RANDOM Qwen3, real Trainer/PEFT, save/reload.

This verifies wiring, NOT Korean quality or CUDA/bitsandbytes. No model download.
"""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import torch
from peft import PeftModel
from tokenizers import Tokenizer, models
from transformers import PreTrainedTokenizerFast, Qwen3Config, Qwen3ForCausalLM, set_seed

from run import HERE, add_lora, load_model, read_json, reply_loss_inputs, trainer_for


class StackTest(unittest.TestCase):
    def test_no_gpu_fails_before_model_download(self):
        with patch('torch.cuda.is_available', return_value=False), \
                patch('transformers.AutoModelForCausalLM.from_pretrained') as download:
            with self.assertRaisesRegex(RuntimeError, 'cuda GPU not found'):
                load_model(read_json(HERE / 'pilot.json'), device='cuda')
            download.assert_not_called()

    def test_reply_logits_preserve_loss_and_gradients(self):
        torch.set_num_threads(1)
        set_seed(42)
        base = Qwen3ForCausalLM(Qwen3Config(
            vocab_size=8, hidden_size=16, intermediate_size=32, num_hidden_layers=1,
            num_attention_heads=2, num_key_value_heads=1, head_dim=8,
            max_position_embeddings=64, tie_word_embeddings=True, pad_token_id=1))
        config = {**read_json(HERE / 'pilot.json'), 'lora_r': 2, 'lora_alpha': 4, 'lora_dropout': 0}
        model = add_lora(base, config)
        with torch.no_grad():
            for name, p in model.named_parameters():
                if 'lora_B' in name:
                    p.normal_(std=0.01)
        inputs = {'input_ids': torch.tensor([[3, 4, 5, 6, 7, 2], [3, 4, 5, 6, 2, 1]]),
                  'attention_mask': torch.tensor([[1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 0]]),
                  'labels': torch.tensor([[-100, -100, -100, 6, 7, 2], [-100, -100, -100, -100, 2, -100]])}
        trimmed = reply_loss_inputs(inputs)
        self.assertEqual(trimmed['logits_to_keep'], 4)
        self.assertIs(trimmed['input_ids'], inputs['input_ids'])
        self.assertEqual(inputs['labels'].shape[1], 6)
        for normalization in (None, torch.tensor(9)):
            model.zero_grad()
            full = model(**inputs, num_items_in_batch=normalization).loss
            full.backward()
            gradients = {name: p.grad.clone() for name, p in model.named_parameters() if p.requires_grad}
            model.zero_grad()
            cropped = model(**trimmed, num_items_in_batch=normalization).loss
            cropped.backward()
            torch.testing.assert_close(cropped, full, rtol=1e-5, atol=1e-6)
            for name, p in model.named_parameters():
                if p.requires_grad:
                    torch.testing.assert_close(p.grad, gradients[name], rtol=1e-5, atol=1e-6)
        with self.assertRaisesRegex(ValueError, 'No supervised'):
            reply_loss_inputs({**inputs, 'labels': torch.full_like(inputs['labels'], -100)})

    def test_train_mask_pad_save_reload(self):
        torch.set_num_threads(1)
        set_seed(42)
        tokenizer = PreTrainedTokenizerFast(tokenizer_object=Tokenizer(models.WordLevel(
            {'[UNK]': 0, '[PAD]': 1, '[EOS]': 2, 'a': 3, 'b': 4, 'c': 5}, unk_token='[UNK]')),
            unk_token='[UNK]', pad_token='[PAD]', eos_token='[EOS]')
        architecture = Qwen3Config(vocab_size=6, hidden_size=16, intermediate_size=32,
                                  num_hidden_layers=1, num_attention_heads=2, num_key_value_heads=1,
                                  head_dim=8, max_position_embeddings=64, tie_word_embeddings=True,
                                  pad_token_id=1, eos_token_id=2)
        base = Qwen3ForCausalLM(architecture)
        initial = deepcopy(base.state_dict())
        config = {**read_json(HERE / 'pilot.json'), 'epochs': 1, 'gradient_accumulation_steps': 1,
                  'lora_r': 2, 'lora_alpha': 4, 'lora_dropout': 0, 'learning_rate': 0.001}
        model = add_lora(base, config)
        rows = [
            {'input_ids': [3, 4, 2], 'attention_mask': [1, 1, 1], 'labels': [-100, 4, 2]},
            {'input_ids': [3, 5, 4, 2], 'attention_mask': [1, 1, 1, 1], 'labels': [-100, -100, 4, 2]},
        ]
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            trainer = trainer_for(model, tokenizer, rows, rows, config, output / 'checkpoints', max_steps=2, use_cpu=True)
            padded = trainer.data_collator(deepcopy(rows))
            self.assertEqual(padded['labels'][0].tolist(), [-100, 4, 2, -100])
            trainer.train()
            self.assertTrue(any(torch.count_nonzero(p).item() for name, p in model.named_parameters() if 'lora_B' in name))
            for name, value in model.get_base_model().state_dict().items():
                if 'lora_' not in name:
                    torch.testing.assert_close(value, initial[name.replace('.base_layer', '')], rtol=0, atol=0)
            model.save_pretrained(output / 'adapter', safe_serialization=True)
            fresh = Qwen3ForCausalLM(architecture)
            fresh.load_state_dict(initial)
            restored = PeftModel.from_pretrained(fresh, output / 'adapter')
            model.eval()
            restored.eval()
            inputs = torch.tensor([[3, 4, 2]])
            with torch.inference_mode():
                expected = model(inputs).logits
                torch.testing.assert_close(restored(inputs).logits, expected)
                with restored.disable_adapter():
                    baseline = restored(inputs).logits
                self.assertGreater((baseline - expected).abs().max().item(), 0)
            self.assertTrue((output / 'checkpoints' / 'checkpoint-2' / 'trainer_state.json').exists())


if __name__ == '__main__':
    unittest.main()
