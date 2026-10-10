#!/usr/bin/env python3
"""게임 스크립트 테이블에서 캐릭터별 실제 대사를 뽑는다.

feilongproject/ba-data (JP 브랜치)의 DB/ScenarioScriptExcelTable.json (git-lfs, 약 148MB).
메인 스토리·이벤트·그룹 스토리가 한 테이블에 들어 있다. 대사가 두 가지 형식으로 온다.

  `1;호시노;07;이 정도의 강행군은 아저씨에겐 무리라고.`   타입;화자;id;대사
  `#na;호시노;응, 아저씨도 준비 완료.`                      #na;화자;대사

뒤에 붙는 `#n`(줄바꿈), `#1;em;[감정]` 같은 연출 명령과 색상·루비 태그를 걷어낸다.
인연 스토리는 이 테이블에 없다(별도 테이블이며 공개 덤프가 없다).

Run:  python3 tools/vendor/vendor_story_lines.py
캐릭터 목록은 resource/persona/characters.json에서 읽는다.
"""
import codecs
import collections
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import persona_common

REPO = 'feilongproject/ba-data'
BRANCH = 'JP'
TABLE = 'DB/ScenarioScriptExcelTable.json'

# 한 항목에 여러 화자가 들어간다: `1;사쿠라코;01\n5;미네;01\n3;나기사 스탠딩;15;하나코 씨.`
# 앞의 둘은 대사가 없고 마지막만 말한다. 그래서 첫 화자만 보면 대부분을 놓친다.
# 각 `슬롯;화자;id;` 지점을 표시하고, 다음 지점까지의 글을 그 화자의 대사로 본다.
SEGMENT = re.compile(r'(?<!#)(?:([1-5]);([^;\n]{1,24});([^;\n]*);|#na;([^;\n]{1,24});)')
# `아즈사;01;음. 과연.` 처럼 대사 자리에 다른 화자가 이어지는 경우가 있다.
ARTIFACT = re.compile(r'^[^ ]{1,24}:\d{2}$')
ALIAS = {'와카모 마스크': '와카모', '사오리 마스크': '사오리', '미사키 마스크': '미사키', '아츠코 마스크': '아츠코'}
VARIANT = re.compile(r'\s*(스탠딩|교복|무장|수영복|테러|언노운|마스크|통신)$')
TAGS = re.compile(r'\[[^\]]*\]')
KOREAN = re.compile(r'[가-힣]')
JUNK = re.compile(r'(펼치기|접기|선택지|^\.+$)')


def clean(text):
    text = text.split('\n#')[0]                       # 연출 명령은 대사가 아니다
    text = re.sub(r'\[ruby=(.*?)\](.*?)\[/ruby\]', r'\2', text)
    text = TAGS.sub('', text).replace('#n', ' ')
    return ' '.join(text.replace('#', '').split()).strip()


def lines_in(script):
    """한 ScriptKr에서 (화자, 대사)를 뽑는다. 한 항목의 여러 화자를 모두 본다."""
    marks = list(SEGMENT.finditer(script))
    out = []
    for index, mark in enumerate(marks):
        name = (mark.group(2) or mark.group(4) or '').strip()
        end = marks[index + 1].start() if index + 1 < len(marks) else len(script)
        text = clean(script[mark.end():end])
        if name and text:
            out.append((name, text))
    return out


def table_scripts(path, wanted):
    """테이블에서 우리 캐릭터 이름이 들어간 ScriptKr만 꺼낸다.

    148MB를 통째로 json.load 하지 않는다. 이름이 들어간 줄만 이스케이프를 푼다.
    """
    text = io.open(path, encoding='utf-8', errors='replace').read()
    found = re.findall(r'"ScriptKr":\s*"((?:[^"\\]|\\.)*)"', text)
    del text
    for raw in found:
        if any(name in raw for name in wanted):
            yield json.loads(f'"{raw}"')


def main():
    roster = persona_common.roster()
    ids = {name: key for key, name in roster.items()}
    path = persona_common.lfs_fetch(REPO, BRANCH, TABLE)

    speakers = collections.defaultdict(list)
    seen = collections.defaultdict(set)
    total = 0
    for script in table_scripts(path, roster.values()):
        total += 1
        for speaker, text in lines_in(script):
            key = ids.get(ALIAS.get(VARIANT.sub('', speaker), speaker))
            if key is None:                       # 로스터 밖 캐릭터는 담지 않는다
                continue
            if not KOREAN.search(text) or len(text) < 2 or len(text) > 160:
                continue
            if ';' in text or ARTIFACT.match(text) or JUNK.search(text):
                continue
            if text in seen[key]:
                continue
            seen[key].add(text)
            speakers[key].append(text)

    characters = {key: speakers[key] for key in roster if speakers[key]}
    out, counts = persona_common.write(
        'story_lines.json',
        f'{REPO} {BRANCH} 브랜치의 {TABLE} — `타입;화자;id;대사`와 `#na;화자;대사` 형식에서 화자 복원',
        characters, lines=sum(len(v) for v in characters.values()))
    missing = [key for key in roster if key not in characters]
    print(f'{total:,}개 대사 항목 → {out}')
    print(f"  캐릭터 {counts['characters']}명 · 대사 {counts['lines']:,}줄"
          + (f' · 대사 없음: {missing}' if missing else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
