# 캐릭터 LoRA 실험 작업틀

**[실제 학습 결과](RESULTS.md):** Apple M4에서 유우카·미카·아리스 Qwen3-1.7B 어댑터를 학습하고 저장/재로딩·원본 대조·고정 프로브까지 완료했다. 선택지 분기를 전부 열거해 표본을 1.5~2배로 늘린 재실험(v4)에서도 **자동 점검을 통과한 후보가 없고 품질은 미달**이다. 실험용 파일과 실패 기록을 보존하며 앱에 자동 배포하지 않는다.

**유우카(`Yuuka`) · 미카(`CH0069`) · 아리스(`Aris`)** 각각에 대해 독립적인 PEFT LoRA를 학습하고, 같은 캐릭터 카드로 원본 모델과 비교한다. GPU를 대여하거나 데이터를 업로드하는 코드는 없다.

설치부터 학습·재로딩·비교·결과 기록까지 실행하는 **자동 루프**를 포함한다. 수십 건짜리 데이터이므로 파이프라인 시험용이지 말투 품질이 검증된 완성 데이터셋이 아니다. 실행 결과는 `runs/<실험명>/summary.md`와 실제 `comparison.jsonl`로 확인한다.

## 0. 한 번에 실행

uv와 GPU 드라이버가 준비되어 있으면 승인 질문 없이 진행한다. 기본 대상은 유우카·미카다.

```sh
cd training/lora
./train-loop.sh --out runs/my-first-loop
# 장치 고정: --device cuda 또는 --device mps
# 최대 한 후보만: --attempts 1
# 더 큰 모델: --config pilot-1.7b.json
# 중단한 동일 실행을 명시적으로 재개: 같은 옵션에 --resume 추가
```

루프 순서:

1. `uv sync --locked`로 프로젝트 전용 환경 설치.
2. CUDA/MPS 확인 → 오프라인 CPU Trainer/PEFT 검사.
3. 전체 저장소+Node가 있으면 앱 조립기로 데이터 재생성. 폴더만 옮겼으면 동봉 데이터를 복사. 실행별 데이터는 동결한다.
4. 실제 토크나이저로 체크섬·loss mask·토큰 길이 검사.
5. 캐릭터마다 **새 베이스**에서 3 epoch 학습 → 어댑터 저장 → 별도 프로세스에서 재로딩·base/off 대조 생성.
6. 유한 loss/가중치 갱신/파일 해시/전체 비교 항목 확인. 잘림·언어 이탈·반복·장식·지문·질문 되풀이·말끝 불일치·기억/일정 조작 의심을 제한적인 규칙으로 검사.
7. 자동 점검에 걸리면 **LR 1e-4 → 5e-5**의 두 번째 사전 지정 후보를 시험. 후보를 고르고 요약 저장.

**후보 최대 2개/캐릭터, 기본 전체 40분, 단계별 15분, 남은 디스크 2GiB 미만이면 중단**한다. `--minutes 1..120`으로 이번 호출의 시간 한도를 바꿀 수 있다. GPU 오류·다운로드 오류·시간 초과는 로그를 남기고 **재시도하지 않는다**. 같은 작업 공간의 중복 루프는 커널 잠금으로 막는다. 재개 시 코드/설정/입력이 바뀌었으면 새 출력 폴더를 요구한다. 실행 중 소스가 바뀌어도 다음 단계 전에 중단한다. 원래 실행 소스는 `source/`에 보존한다.

`screen_pass`는 말투 품질 승인이나 안전성 증명이 아니다. 검증 loss가 원본의 1.05배 이하이고 규칙상 경고가 없어도 **`needs_semantic_review`**를 남긴다. 모든 후보에 문제가 있어도 숨기지 않고 실험 결과로 보존하며 앱에는 자동 배포하지 않는다. `summary.json`의 선정 결과는 '실험 후보'다.

## 1. 환경

- 학습: **Linux x86_64/WSL2 + NVIDIA CUDA**, 또는 **macOS ARM + Apple Metal(MPS)**. 단일 프로세스/단일 GPU. `auto`는 CUDA → MPS 순이며 CPU로 몰래 전환하지 않는다.
- Python **3.11**, [uv](https://docs.astral.sh/uv/getting-started/installation/).
- PyTorch **2.8.0 / CUDA 12.8** wheel. CUDA 12.8을 지원하는 드라이버가 필요하다. RTX 20/30/40/50 계열을 우선 대상으로 한다. 먼저 `nvidia-smi`로 드라이버/GPU가 보이는지 확인한다.
- VRAM **8GB 이상을 시작 권장값**으로 잡았다. 실제 GPU 최대 메모리는 아직 측정하지 않았다. 메모리가 모자라면 아래 QLoRA 옵션을 사용한다. GPU 지원 범위와 실제 VRAM 사용량은 장치별 검증이 필요하다.
- 디스크는 환경·CUDA 라이브러리·HF 캐시·체크포인트를 위해 **20GB 이상** 여유 권장.
- macOS ARM에서는 실제 MPS 학습을 지원한다. BF16 연산을 확인하고 지원하지 않으면 FP32를 쓴다. MPS 드라이버 권장 메모리의 70%로 프로세스 한도를 두며 high-watermark 보호를 끄지 않는다. 작은 랜덤 모델의 테스트만 CPU로 실행한다. AMD/ROCm, native Windows, 분산 학습은 이번 작업틀의 지원 대상이 아니다.

`pyproject.toml` + **`uv.lock`**이 전이 의존성과 플랫폼별 wheel을 고정한다. Linux는 공식 CUDA wheel, macOS는 MPS 지원 wheel을 사용한다. 시스템 CUDA toolkit/FlashAttention/Docker/TRL은 설치하지 않아도 된다.

```sh
cd training/lora
uv sync --locked
uv run --locked python run.py check
uv run --locked python run.py validate
```

`check`는 모델을 받지 않고 CUDA/MPS를 확인한다. `validate`는 **토크나이저만** 받고 실제 토큰 길이, assistant-only label mask, 채팅 템플릿 접두사, EOS, 데이터 체크섬을 검사한다.

기본 모델은 `Qwen/Qwen3-0.6B`의 `c1899de289a04d12100db370d81485cdf75e47ca` revision. 한국어 품질의 최종 선택이 아니라 저비용 시험용이다. `pilot-1.7b.json`은 `Qwen/Qwen3-1.7B`의 `70d244cc86ccca08cf5af4e1e306ecf908b1ad5e` revision을 고정한 별도 실험 설정이다(가중치 다운로드 약 3.8GiB). 베이스 모델 라이선스는 Apache-2.0이다. 모델/크기를 바꾸려면 `pilot.json`을 복사해 **model ID와 해당 revision을 함께** 바꾸고 `--config`로 지정한 뒤 `validate`부터 다시 실행한다. 현재 학습기의 reply-logits 최적화는 Qwen3만 허용한다. 다른 아키텍처를 추가하려면 LoRA 대상 모듈·채팅 템플릿·logits 절단 시 loss 동등성을 코드에서 별도 검증해야 한다.

## 2. 다른 GPU PC로 옮기기

`data/`에 준비된 결과가 들어 있어 **학습 PC에는 이 폴더만 있으면 된다**. Node.js나 게임 전체 테이블을 다시 설치/다운로드할 필요가 없다. `.venv`는 운영체제 간 이동하지 말고 GPU PC에서 다시 만든다.

저장소 루트에서:

```sh
tar --exclude='.venv' --exclude='__pycache__' --exclude='runs' --exclude='.cache' \
  -czf /tmp/molu-lora-pilot.tar.gz training/lora
# /tmp/molu-lora-pilot.tar.gz를 GPU PC로 복사
```

GPU PC에서:

```sh
tar -xzf molu-lora-pilot.tar.gz
cd training/lora
./train-loop.sh --out runs/gpu-pc-loop   # 설치·검증·학습·비교까지 순차 실행
```

처음 환경/모델을 받을 때는 인터넷이 필요하다. 캐시를 갖춘 뒤 `HF_HUB_OFFLINE=1`로 실행할 수 있다. 캐시 위치를 바꾸려면 `HF_HOME=/큰디스크/hf-cache`를 지정한다. 토큰/비밀번호를 설정 파일이나 저장소에 넣지 않는다. 기본 모델은 공개 모델이라 HF 로그인 없이 사용할 수 있다.

## 3. 두 단계 실행: 연결 시험 → 짧은 학습

먼저 세 캐릭터 모두 **optimizer 2 step**만 돌려 GPU/저장 경로를 확인한다. 이 출력으로 말투 개선을 판단하지 않는다.

```sh
for id in Yuuka CH0069 Aris; do
  uv run --locked python run.py train --character "$id" --smoke --out "runs/smoke-$id" || break
done
```

이후 기본 3 epoch의 작은 실험과 비교를 순차 실행한다. 같은 GPU에 세 학습을 동시에 띄우지 않는다.

```sh
for id in Yuuka CH0069 Aris; do
  uv run --locked python run.py train --character "$id" --out "runs/pilot-$id" || break
  uv run --locked python run.py compare --run "runs/pilot-$id" || break
done
```

- 캐릭터별로 **새 베이스 모델에서 시작**한다. 앞 캐릭터의 어댑터를 이어 학습하지 않는다.
- `pilot.json`: rank 8 / alpha 16, attention q/k/v/o, dropout 0.05, LR 1e-4, microbatch 1, gradient accumulation 4, max length 2048.
- BF16 지원 GPU는 BF16. 미지원 시 CUDA는 FP16, MPS는 FP32. gradient checkpointing 사용. 길이가 넘는 데이터는 **조용히 자르지 않고 오류**로 알린다.
- 메모리 절약: attention에는 **전체 문맥**을 전달하되 `logits_to_keep`로 마지막 답변을 예측하는 위치부터만 어휘 logits를 계산한다. 첫 정답 직전 위치를 포함하고 labels도 함께 잘라 원래 causal loss를 유지한다. 무시되는 system/history의 거대한 어휘 출력은 만들지 않는다. 전체 logits 방식과 loss·LoRA gradient 동등성 테스트를 포함한다. MPS 메모리 보호를 끄는 우회가 아니다.
- 데이터가 작아 3 epoch도 품질 보장은 없다. 에피소드당 여러 응답은 서로 독립된 표본도 아니다. 무작정 반복 횟수를 늘리면 원문만 외울 수 있다.
- 기존 출력 디렉터리는 덮어쓰지 않는다. 다시 실험할 때는 `--out runs/pilot-v2-Yuuka`처럼 새 경로를 쓴다.
- epoch 체크포인트는 최근 두 개를 보존한다. 중단 후에는 **같은 config/data/QLoRA/smoke 설정**으로 `--resume`을 붙인다. 완료된 실행의 재학습은 새 경로를 쓴다.

```sh
uv run --locked python run.py train --character Yuuka --out runs/pilot-Yuuka --resume
```

### 선택: 4-bit QLoRA

별도 프레임워크 없이 동일한 코드에서 베이스 가중치만 NF4로 읽는다. LoRA와 결과를 섞지 않도록 출력 경로도 나눈다.

```sh
uv sync --locked --extra qlora
uv run --locked --extra qlora python run.py train \
  --character Yuuka --qlora --smoke --out runs/qlora-smoke-Yuuka
uv run --locked --extra qlora python run.py compare --run runs/qlora-smoke-Yuuka
```

전체 자동 루프는 `./train-loop.sh --qlora --device cuda --out runs/qlora-loop`로 실행한다. QLoRA는 MPS에서 지원하지 않는다.

`--smoke`를 빼고 새 경로로 실행하면 3 epoch 실험이다. 이후에도 `uv run --extra qlora`를 유지한다. 메모리가 부족하다고 CPU/offload로 자동 전환하지 않는다. **CUDA 학습과 bitsandbytes 경로는 이 저장소를 준비한 Mac에서는 검증하지 못했다.**

## 4. 데이터: 원문, 분기, 에피소드 경계

| 캐릭터 | train 응답 | held-out eval 응답 |
|---|---:|---:|
| 유우카 | 21 | 2 |
| 미카 | 13 | 1 |
| 아리스 | 18 | 4 |

2026-10 갱신: 선택지 **모든 실제 분기**를 열거한다(이전에는 Answer 그룹마다 ID 순 첫 선택지만 사용). 각 경로는 Answer 그룹마다 선택지 하나만 갖고 그 선택의 실제 `NextGroupId`를 따르며, 서로 다른 선택지를 한 이력에 나열하지 않는다. 같은 응답에 도달해도 선택 경로가 다르면 별도 표본이다(샘플 ID에 경로 태그 포함, 내용이 완전히 같은 표본은 한 번만). 분기 상한(에피소드당 64회 확장)에 걸리면 `manifest.json`의 `branch_cap_hit`에 남고 조용히 넘어가지 않는다. 분기가 늘어 표본은 1.5~2배가 됐지만 여전히 캐릭터당 수십 건 규모다.

- 원본: [feilongproject/ba-data, JP 브랜치의 AcademyMessangerExcelTable](https://github.com/feilongproject/ba-data/blob/JP/DB/AcademyMessangerExcelTable.json)의 한국어 필드. `source.json`은 세 명의 **253개 원본 행**에서 사용하는 필드만 뽑은 스냅샷이다. 원본 테이블/프로필 SHA-256과 캐릭터 숫자 ID를 남겼다.
- 기존 `resource/persona/momotalk.json`의 `pairs`는 학습에 쓰지 않는다. 일부 선택지별 `NextGroupId`가 다른데 첫 번째 경로로 묶거나, 인연 스토리 전후/다음 에피소드까지 답변에 연결되는 문제가 확인되었다. 기존 앱 데이터는 이번 작업에서 변경하지 않았다.
- `prepare.py`는 `FavorRankUp`을 에피소드 시작으로, `FavorScheduleId`/`PreConditionFavorScheduleId`를 스토리 전후 분리 지점으로 사용한다. 인연 스토리 **본문을 보충/상상하지 않는다**.
- 선택지 그룹(Answer)에서 **모든 실제 선택지**를 각각의 경로로 열거하고, 각 경로는 선택지 하나와 그 선택의 실제 `NextGroupId`만 따른다. 서로 다른 선택지를 한 이력에 나열하지 않는다. 내용이 완전히 같은 표본은 한 번만 남긴다.
- 학생이 먼저 보낸 메시지와 앞선 선택/응답은 **맥락**으로 보존한다. 마지막 assistant 응답에만 loss를 적용하고 system·이력·user·padding·Qwen thinking 접두사는 마스킹한다.
- 장식 문자 제거/공백 정리/연속 말풍선 연결만 한다. 깨진 자모가 포함된 샘플은 제외하고 이유를 기록한다. 창작 질문에 원문 대사를 임의로 붙이지 않는다.
- **에피소드 전체**를 train/eval 중 한쪽에 둔다. 스토리 전후 segment도 같은 split에 둔다. eval 정답이 train의 assistant 이력/정답에 똑같이 나타나는 샘플은 제거한다. 의미상 유사한 문장까지 자동 탐지하는 것은 아니다.
- 1개 에피소드씩만 검증용으로 남긴 극소량 split이다. 정식 test set이나 일반화 성능 벤치마크가 아니다. 다른 캐릭터/새 테이블에는 이 경계 규칙을 다시 검토해야 한다.

각 JSONL 행에는 `episode`, `segment`, `source_message_ids`가 있어 원문 추적이 가능하다. `data/manifest.json`은 split·제외 사유·파일 해시를 기록한다.

### 공유 세계관과 카드

**원본은 여전히 `resource/persona/characters.json` 한 곳**이다. `export_cards.ts`가 앱의 `systemPromptFor()`를 그대로 호출해 공유 world/rules/factions + 해당 캐릭터 역할/관계를 조립한다. 학습 코드에 세계관을 다시 작성하지 않는다.

`data/cards.json`은 GPU PC로 옮길 때 쓰는 **생성된 고정 스냅샷**이다. JSONL에는 system 텍스트를 매 행 복사하지 않고 `character`로 참조한다. 학습 직전에 해당 카드를 붙인다. 학습/비교에는 앱의 few-shot 예시를 넣지 않는다. held-out 대사가 few-shot으로 유출될 수 있기 때문이다.

앱과 공통 원본을 수정한 뒤, **전체 저장소**에서 재생성한다(Node 22+, Python; ML 의존성 불필요):

```sh
python3 training/lora/prepare.py
python3 -m unittest discover -s training/lora -p 'test_pipeline.py' -v
```

원본 테이블 스냅샷까지 갱신할 때만 로컬 파일을 명시한다. 이 명령이 스냅샷과 준비 데이터를 갱신한다.

```sh
python3 training/lora/prepare.py \
  --source-table /path/AcademyMessangerExcelTable.json \
  --profile-table /path/LocalizeCharProfileExcelTable.json
```

대사 저작권·캐릭터 권리와 베이스 모델 라이선스는 별개다. 공개된 게임 덤프/위키라고 학습·배포 권한이 자동 보장되지는 않는다. JP 브랜치의 한국어 필드와 직접 작성한 페르소나도 출시된 한국판/공식 설정과 별도 검토가 필요하다. 데이터와 어댑터 공개·상업 이용 전 관련 권리를 확인한다.

## 5. 산출물과 비교

```text
runs/pilot-Yuuka/
  adapter/                 PEFT adapter_config.json + adapter_model.safetensors + tokenizer
  card.json                캐릭터 카드 + 호환 base_model/revision + 상대 adapter 경로
  run.json                 상태, 실제 환경, 고정 설정, 데이터/lock/가중치 해시, train/eval loss
  checkpoints/             중단 복구용 Trainer 상태
  eval.jsonl               이 실행의 고정 검증 대화
  probes.json              이 실행의 고정 공통 질문
  comparison.jsonl         base / lora 답변, reference, 토큰 제한 도달 여부
```

`compare`가 **실제로 저장된 어댑터를 다시 로드**한다. 같은 베이스·양자화 설정·카드·이력·seed·샘플링으로 어댑터 off/on을 비교한다. held-out 대화와 학습에 넣지 않은 6개 일상/환각 점검 질문을 함께 사용한다. 비교는 `.partial`에 기록하고 완료 시 최종 파일로 바꾼다. `--resume`이면 실행 해시와 기존 항목을 검증한 뒤 이어간다. 새 비교는 `--out runs/pilot-Yuuka/comparison-v2.jsonl`처럼 지정한다.

자동 루프의 상위 폴더에는 `state.json`(실행 지문·단계 상태), `logs/`(명령별 로그), 동결된 `data/`, 후보별 설정, `summary.json`/`summary.md`가 생긴다. 각 후보에는 `report.json`과 원본/LoRA 검증 loss가 추가된다. 일시적인 품질 점수만 믿고 가중치를 배포하지 않는다.

사람이 볼 항목:

1. 존댓말/반말과 캐릭터별 말버릇이 맞고, 질문에 답하는가?
2. 학습한 게임 장면·대사를 뜬금없이 반복하지 않는가?
3. 알려주지 않은 기억/일정을 만들거나 캘린더 작업을 완료했다고 하지 않는가?
4. 지나치게 짧거나 길고, 이모지/지문이 나오거나 응답이 잘리지 않는가?

작은 데이터에서 loss가 낮아졌다는 이유만으로 말투가 좋아졌다고 판단하지 않는다. 개선이 보이면 새 에피소드/상황을 검수해 늘리고, 별도의 고정 test set을 만든 뒤 모델 크기·rank·학습률을 비교한다.

### 학습된 카드·어댑터 옮기기

프레임워크 압축 명령은 `runs/`를 제외한다. 실제 모델은 `summary.json`에 기록된 후보 폴더를 별도로 옮긴다. 폴더 안의 `card.json`, `run.json`, `adapter/`, `eval.jsonl`, `probes.json`, `comparison.jsonl`, `report.json`을 함께 보존한다. `checkpoints/`는 학습 재개가 필요할 때만 필요하다.

```sh
# 저장소 루트에서. 실제 실행 폴더 이름에 맞춘다.
tar --exclude='checkpoints' -czf /tmp/character-adapters.tar.gz \
  -C training/lora/runs 실험명
```

베이스 전체 가중치는 어댑터 압축에 포함하지 않는다. 대상 PC에서 처음 로드할 때 카드에 고정된 베이스를 내려받으므로 디스크와 네트워크를 준비한다. LoRA 파일만을 독립 모델처럼 실행할 수는 없다. 품질 미달 실험도 삭제하거나 성공으로 바꾸지 말고 비교 증거와 함께 보관한다.

## 5.5 프롬프트 수준 기억 검증 (모델 학습과 별개)

앱의 기억 기능이 실제 프롬프트에서 동작하는지 **로컬 Qwen3**로 확인하는 프로브가 있다. 앱과 같은 조립 코드(`src/lib/ai/persona.ts`·`src/lib/chat/memory.ts`·`src/lib/chat/prompt.ts`)를 Node로 실행해 프롬프트를 만들고, 이 프로젝트의 환경에서 추론한다.

```sh
cd training/lora
node build_memory_probes.ts runs/memory-probe/prompts.jsonl   # 6사실 × 5변형 = 30건
uv run --locked python memory_probe.py                          # Qwen/Qwen3-1.7B, MPS/CUDA
# 선택: --adapter runs/<실험>/<캐릭터>/adapter --device cuda --limit 10
```

- 변형: `memory`(기억 포함) · `no-memory`(기억 없음) · `expired`(만료) · `disabled`(사용 중지) · `cross-room`(다른 방의 기억).
- `prompts.jsonl`은 조립 단계에서 참고 자료 포함 여부·마지막 질문·문자 예산을 검사하고 실패하면 중단한다.
- 결과는 `runs/memory-probe/responses.jsonl`과 `summary.md`. 키워드 기반 자동 판정은 참고 지표이며, 원문 답변을 함께 남긴다.
- **앱 모델(Gemma 4 LiteRT)이 아니라 프롬프트 구조 검증이다.** 앱 품질 보장으로 확대 해석하지 않는다.

측정으로 확인한 것(로컬 Qwen3-1.7B, 3표본 평균):

- 프롬프트에 `[말투]`(register 파생 문장)나 `[분량]`(캐릭터별 문장 수) 블록을 **추가해도 지표가 나아지지 않았다**(각 168표본·60표본 A/B). 그래서 앱 프롬프트에는 넣지 않았고, 파생값은 프로브 판정 기준으로만 쓴다.
- 예시 자체가 규칙보다 강하게 작동한다: 앱 규칙은 2~4문장인데 예시 115개 중 24개가 5문장 이상이었고, 모델도 그 리듬을 따라 길게 말했다. `tools/vendor/select_examples.py`에 종결 부호 기준 문장 수 점수(2~4 보너스, 5+ 감점)를 넣어 예시를 규칙 쪽으로 맞췄다(24 → 16개).

## 5.6 말투 프로브 (고정 평가셋, 모델 학습과 별개)

앱 프롬프트(카드+실제 대사 예시)가 지키라고 한 말투를 실제로 지키는지 측정한다. 앱의 `chatMessagesFor()`로 14명 × 4질문(인사·부탁·감정·일정) = 56개 프롬프트를 만들고 로컬 Qwen3로 생성한 뒤 지표를 자동 판정한다.

```sh
cd training/lora
node build_style_probes.ts runs/voice-probe/prompts.jsonl
uv run --locked python voice_probe.py                      # 생성 + 채점
uv run --locked python voice_probe.py --rejudge            # 모델 없이 저장된 답변 재채점(지표 수정용)
uv run --locked python voice_probe.py --adapter <path> --filter Yuuka   # 어댑터 비교
```

지표(휴리스틱, 원문 답변을 함께 저장):

| 지표 | 보는 것 |
|---|---|
| `register` | 카드의 register 대비 종결형. 존댓말은 존대 종결 ≥50%, 반말은 ≤20% |
| `sentences` | 캐릭터별 기대 문장 수(그 캐릭터 예시의 중간값에서 파생, `replyLengthRange`)와 비교 |
| `decoration` | 이모지·장식 문자·인용 부호 남용 |
| `narrator` | 지문·3인칭 서술·다른 캐릭터를 주어로 한 문장. 자기 이름 3인칭 말버릇(아리스·와카모 실제 대사)은 위반 아님 |
| `identity` | 선생님을 자기 이름이나 다른 캐릭터 이름으로 부르는지 |
| `echo` | 사용자 메시지를 거의 그대로 되받는지 |
| `invented` | 카드에 없는 약속/기억을 단정하는지(일정·기억 질문) |

맥락 창 프로브(최근 왕복 수 결정용): `node build_context_probes.ts runs/context-probe/prompts.jsonl` + `uv run --locked python memory_probe.py --prompts runs/context-probe/prompts.jsonl --samples 3`. 사실을 3왕복 전에 말한 뒤 회상 질문을 던져 창 크기(2 vs 4왕복)와 기억 주입을 비교한다(결과: [RESULTS.md](RESULTS.md)).

**앱 모델(Gemma 4 LiteRT)이 아니라 프롬프트 구조 검증이다.** 앱 품질 보장으로 확대 해석하지 않는다.

측정으로 확인한 것(로컬 Qwen3-1.7B, 3표본 평균):

- 프롬프트에 `[말투]`(register 파생 문장)나 `[분량]`(캐릭터별 문장 수) 블록을 **추가해도 지표가 나아지지 않았다**(각 168표본·60표본 A/B). 그래서 앱 프롬프트에는 넣지 않았고, 파생값은 프로브 판정 기준으로만 쓴다.
- 예시 자체가 규칙보다 강하게 작동한다: 앱 규칙은 2~4문장인데 예시 115개 중 24개가 5문장 이상이었고, 모델도 그 리듬을 따라 길게 말했다. `tools/vendor/select_examples.py`에 종결 부호 기준 문장 수 점수(2~4 보너스, 5+ 감점)를 넣어 예시를 규칙 쪽으로 맞췄다(24 → 16개).

## 6. 앱 연결 범위

현재 앱의 LiteRT-LM/Gemma에는 이 PEFT 어댑터를 직접 로드하는 기능을 추가하지 않았다. **Qwen용 LoRA는 Gemma에 적용할 수 없으며**, Qwen WebLLM 양자화 모델과도 파일 형식이 같지 않다.

설치된 런타임의 API도 확인했다(2026-10, `@litert-lm/core` 0.17.1). `dist/engine_settings.d.ts`·`dist/wasm_binding_types.d.ts`에서 LoRA 관련 표면은 **`GpuArtisanConfig.supported_lora_ranks: number[]`(런타임이 지원하는 rank 목록)뿐**이고, 어댑터 파일을 지정해 붙이는 파라미터(`EngineSettings`, `LlmExecutorSettings`)는 공개 타입에 없다. 레거시 MediaPipe LLM Inference처럼 모델 자산에 LoRA를 함께 묶는 방식도 이 패키지에는 없다. 따라서 현재 고정한 브라우저 런타임에서 PEFT 어댑터를 붙일 경로는 확인되지 않았고, 가정하지 않는다.

앞으로 브라우저에서 어댑터를 쓰려면 최소한 다음이 필요하다: (1) 앱이 실제로 로드하는 베이스와 같은 모델 계열의 어댑터, (2) 런타임이 어댑터 파일과 rank를 받아들이는 API, (3) 어댑터를 붙인 뒤의 말투 재평가. 이 저장소의 실험은 그중 (3)의 절차와 평가 도구를 이미 갖추고 있다.

이번 작업의 로딩 대상은 **GPU PC의 Transformers/PEFT**다. 검증된 어댑터가 나온 뒤 브라우저 런타임의 지원 여부를 확인하고, 필요하다면 베이스에 병합한 후 해당 런타임 형식으로 변환하는 단계가 추가된다. 병합/변환도 말투 재평가가 필요하다. 가중치 형식만 바꾸면 앱에 자동 연결된다고 보장하지 않는다.

## 7. 검증

전체 저장소에서:

```sh
cd training/lora
uv run --locked python -m unittest test_pipeline test_stack test_loop -v
uv run --locked python run.py validate
```

- stdlib 검사: 출처 일치, 실제 분기, 스토리 경계, 중복/에피소드 분리, 깨진 자모 제외, 재생성 동일성, 체크섬, loss mask, 템플릿 변경/길이 초과 거부.
- CPU 통합 검사: **작은 랜덤 Qwen3**로 2 step 학습, LoRA 가중치 변경·베이스 고정·padding mask·체크포인트·저장/재로딩 결과 일치, 전체/응답 전용 logits의 loss·gradient 동등성 확인. 실제 한국어 모델 가중치를 다운로드하지 않는다.
- 실제 고정 Qwen3 토크나이저 검증: 현재 데이터 **814~1,055 tokens**, target **7~166 tokens**. 문자 수로 추정한 값이 아니다.
- 루프 검사: 실패 단계 재시도 금지, 완료 단계 중복 실행 금지, 시간 한도, 후보 선택, 불완전 비교 거부, 규칙 기반 점검 통과와 의미 검증의 구분.
- **NVIDIA/NF4 경로는 이 Mac에서 실행 검증하지 못했다.** 실제 학습/말투 결과는 해당 실행의 `run.json`, `comparison.jsonl`, `summary.md`를 기준으로 판단한다. CPU 테스트나 낮은 loss만으로 캐릭터 품질을 보장하지 않는다.

공식 참고: [Qwen3 model card](https://huggingface.co/Qwen/Qwen3-0.6B), [PEFT quicktour](https://huggingface.co/docs/peft/v0.17.0/en/quicktour), [PEFT quantization](https://huggingface.co/docs/peft/v0.17.0/en/developer_guides/quantization), [Transformers Trainer](https://huggingface.co/docs/transformers/v4.56.2/en/main_classes/trainer), [PyTorch wheels](https://pytorch.org/get-started/previous-versions/).
