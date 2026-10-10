#!/usr/bin/env python3
"""characters.json의 examples만 다시 고른다.

world·rules·persona·register는 건드리지 않는다. 이 스크립트가 소유하는 필드는
examples 하나뿐이라, 페르소나를 손으로 고쳐도 덮어쓰지 않는다.

예시를 뽑는 기준 (모두 momotalk.json의 실제 교환에서):
  - 선생님 말이 완결된 문장일 것. "뭐라고?" 같은 단편은 답이 붙지 않는다.
  - 학생 답이 여러 문장일 것. 규칙이 2~4문장을 요구하는데 예시가 한 문장이면
    모델은 규칙 대신 예시를 따라 한 문장만 낸다.
  - 앞 대화에 기대는 말(아니·근데·그치만)로 시작하지 않을 것.
  - 서로 다른 장면에서 고를 것. 한 대화를 연속으로 넣으면 모델이 그 장면을 이어간다.

순서: 점수가 낮은 것부터 놓아 가장 좋은 쌍이 생성 직전 자리에 오게 한다.
소형 모델은 마지막 예시를 가장 강하게 따라한다.

Run:  python3 tools/vendor/select_examples.py
"""
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import persona_common

DECOR = re.compile(r'[\u2665\u2661\u266a\u266b\u2606\u2605\u2764\ufe0f\u2727\u2728]')
SENTENCE = re.compile(r'[.!?…]')
# 말줄임표(…)·쉼표는 호흡이지 문장이 아니다. 앱 규칙(2~4문장)의 "문장"은 종결 부호로 센다.
SENTENCE_END = re.compile(r'[.!?]')
RULE_SENTENCES = (2, 4)
KOREAN = re.compile(r'[가-힣]')
CONNECTIVE = ('아니', '근데', '그치', '어,', '음,', '그리고', '하지만', '그럼', '저기')
# 게임 테이블에 자모가 깨진 대사가 섞여 있다: "나ㄹ 응응응!!!!!", "조그 ㅁ ㅡ냥 선생님".
# 자모가 음절에 붙거나 홀로 서 있으면 그 쌍은 쓰지 않는다.
BROKEN = re.compile(r'[가-힣][ㄱ-ㅎㅏ-ㅣ]|[ㄱ-ㅎㅏ-ㅣ][가-힣]|(?:^|\s)[ㄱ-ㅎㅏ-ㅣ](?:\s|$)')
PAIRS_PER_CHARACTER = 8
SETS = 2
MIN_TURNS = 4
MAX_TURNS = 6


def clean(text):
    return ' '.join(DECOR.sub('', text).split())


def score(sensei, student):
    value = 0
    if sensei.endswith('?'):
        value += 3
    if sensei.endswith(('.', '!', '~')):
        value += 2
    if len(KOREAN.findall(sensei)) >= 6:
        value += 2
    if len(SENTENCE.findall(student)) >= 2:
        value += 4
    # 앱 규칙은 2~4문장이다. 규칙을 벗어난 긴 답을 예시로 쓰면 모델이 그 길이를 그대로 따라 한다.
    endings = len(SENTENCE_END.findall(student))
    if RULE_SENTENCES[0] <= endings <= RULE_SENTENCES[1]:
        value += 5
    elif endings > RULE_SENTENCES[1]:
        value -= 3
    if student.endswith(('.', '!', '?', '…')):
        value += 3
    if 25 <= len(student) <= 90:
        value += 2
    if student.startswith(CONNECTIVE):
        value -= 3
    return value


# (선생님 말 최소 한글, 학생 답 길이 범위) — 엄격한 것부터. 카요코처럼 원래 말수가
# 적은 캐릭터는 짧은 답이 정본이라, 8턴을 못 채우면 기준을 낮춘다.
LEVELS = ((6, 20, 110), (4, 12, 130), (3, 8, 160))


def usable(sensei, student, level):
    minimum, low, high = LEVELS[level]
    if len(KOREAN.findall(sensei)) < minimum:
        return False
    if level == 0 and not sensei.endswith(('.', '?', '!', '~')):
        return False                      # 단편 질문에는 답이 붙지 않는다
    if BROKEN.search(sensei) or BROKEN.search(student):
        return False
    return low <= len(student) <= high


def pick(pairs):
    """점수 높은 순으로 고른다. 8개를 못 채우면 기준을 낮추고, 그래도 부족하면 있는 만큼 쓴다."""
    for level in range(len(LEVELS)):
        scored = []
        for pair in pairs:
            sensei, student = clean(pair['sensei'][0]), clean(' '.join(pair['student']))
            if not usable(sensei, student, level):
                continue
            scored.append((score(sensei, student), sensei, student))
        scored.sort(key=lambda item: -item[0])
        chosen, seen = [], set()
        for value, sensei, student in scored:
            if sensei in seen or student in seen:
                continue
            seen.add(sensei)
            seen.add(student)
            chosen.append((value, sensei, student))
            if len(chosen) == PAIRS_PER_CHARACTER:
                break
        if len(chosen) >= PAIRS_PER_CHARACTER or (level == len(LEVELS) - 1 and len(chosen) >= MIN_TURNS):
            chosen.sort(key=lambda item: item[0])
            return [(sensei, student) for _, sensei, student in chosen]
    return []


def build(pairs):
    return [message
            for sensei, student in pairs
            for message in ({'role': 'user', 'content': sensei}, {'role': 'assistant', 'content': student})]


def main():
    momotalk = json.load(io.open(os.path.join(persona_common.PERSONA, 'momotalk.json'), encoding='utf-8'))['characters']
    data = json.load(io.open(persona_common.CHARACTERS, encoding='utf-8'))
    changed = 0
    for persona in data['characters']:
        source = momotalk.get(persona['id'])
        if not source:
            print(f"  {persona['id']:9s} 모모톡 없음, 유지")
            continue
        pairs = pick(source['pairs'])
        if len(pairs) < MIN_TURNS:
            print(f"  {persona['id']:9s} 조건에 맞는 쌍이 {len(pairs)}개뿐, 유지")
            continue
        per = PAIRS_PER_CHARACTER // SETS
        if len(pairs) >= PAIRS_PER_CHARACTER:
            persona['examples'][0] = build(pairs[:per])
            persona['examples'][-1] = build(pairs[per:per * 2])
        else:
            # 부족한 모모톡 쌍은 마지막 세트에만 넣어 앞의 음성 대사 예시를 보존한다.
            persona['examples'][-1] = build(pairs[-min(MAX_TURNS, len(pairs)):])
        last = persona['examples'][-1][-1]['content']
        print(f"  {persona['id']:9s} {len(pairs)}턴 · 마지막 답변: {last[:38]}")
        changed += 1
    assert changed >= 10, f'예시를 바꾼 캐릭터가 {changed}명뿐'
    io.open(persona_common.CHARACTERS, 'w', encoding='utf-8').write(
        json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(f'examples 갱신: {changed}명')
    return 0


if __name__ == '__main__':
    sys.exit(main())
