#!/usr/bin/env python3
"""나무위키 캐릭터 문서의 '대사' 표에서 실제 게임 대사(한국어)를 추출한다.

나무위키 대사 표는 `<td>라벨</td><td>일본어<br>한국어</td>` 형태다.
한글이 포함된 줄만 한국어 대사로 본다.

Run:  python3 tools/vendor/vendor_persona_lines.py

PAGES는 나무위키 문서 제목이라 이름에서 유도할 수 없다. 그래서 캐릭터를 추가하면
여기도 함께 고쳐야 하며, 빠뜨리면 아래 검사가 실패한다.
"""
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import persona_common

CACHE = '/tmp/namu-lines'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36'

PAGES = [
    ('Arona', '아로나'),
    ('Prana', '프라나(블루 아카이브)'),
    ('Hoshino', '타카나시 호시노'),
    ('Shiroko', '스나오오카미 시로코'),
    ('Aru', '리쿠하치마 아루'),
    ('Kayoko', '오니카타 카요코'),
    ('Mutsuki', '아사기 무츠키'),
    ('Yuuka', '하야세 유우카'),
    ('Aris', '텐도 아리스'),
    ('Yuzu', '하나오카 유즈'),
    ('Hina', '소라사키 히나'),
    ('CH0069', '미소노 미카'),
    ('Nagisa', '키리후지 나기사'),
    ('Wakamo', '코사카 와카모'),
]

# 라벨이 대사인 행만 남긴다. 프로필·스킬·능력치 표를 걸러내기 위함.
LABEL = re.compile(
    r'^(획득|로비 방문|잡담|편성|편성 선택 대사|전투 시작|전투 승리|전략 승리|전투 패배|'
    r'임무 실패|메모리얼 로비|메모리얼|전술 상호작용|상점|터치|로그인|우편|미니게임|'
    r'학생 소개|인연 스토리|이벤트|특별|대사)\s*\d*$')
HANGUL = re.compile(r'[가-힣]')
JAPANESE = re.compile(r'[\u3040-\u30ff]')
# 스킬·능력치 표는 라벨이 비슷해도 내용이 대사가 아니다.
NOT_DIALOGUE = re.compile(r'(데미지|공격력|방어력|치명|회복력|초당|%|증가|감소|스킬|효과|쿨타임)')


def fetch(name):
    path = os.path.join(CACHE, re.sub(r'[^\w()]', '_', name) + '.html')
    if os.path.exists(path):
        return open(path, encoding='utf-8').read()
    url = 'https://namu.wiki/w/' + urllib.parse.quote(name)
    request = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read().decode('utf-8', 'replace')
    os.makedirs(CACHE, exist_ok=True)
    open(path, 'w', encoding='utf-8').write(body)
    time.sleep(1.0)  # 원본 사이트에 연속 요청을 보내지 않도록 쉬어 간다.
    return body


def rows(body):
    """(라벨, 내용 셀 HTML) 쌍을 문서 순서대로 뽑는다.

    나무위키는 표를 중첩하므로 <table>을 정규식으로 감싸면 안쪽 표에서 끊긴다.
    셀을 평탄하게 나열하고, 라벨 셀과 다음 라벨 셀 사이의 셀을 그 라벨의 내용으로 본다.
    열 개수가 2~4열로 들쭉날쭉해서 '다음 한 칸' 같은 가정은 깨진다.
    """
    cells = re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', body, re.S)

    def text(cell):
        return html.unescape(re.sub(r'<[^>]+>', '', cell)).strip()

    starts = [i for i, cell in enumerate(cells) if LABEL.match(text(cell))]
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(cells)
        label = text(cells[start])
        for cell in cells[start + 1:min(end, start + 5)]:
            yield label, cell


JUNK = re.compile(r'(펼치기|접기|해금 랭크|음성|스킬|목록|편집)')
FOOTNOTE = re.compile(r'\[\d+\]|\[[A-Za-z]+\]')


def korean_lines(cell):
    """셀에서 한국어 대사만 뽑는다.

    일본어와 한국어가 한 셀에 병기되면 <br>이 언어 경계다(각 줄이 완전한 대사).
    한국어만 있는 셀이면 <br>은 문장 안 줄나눔이므로 이어 붙인다.
    """
    plain = html.unescape(re.sub(r'<[^>]+>', '', cell))
    # <br>을 먼저 줄바꿈으로 바꿔야 한다. 태그를 먼저 지우면 <br>도 사라져 단어가 붙는다.
    text = html.unescape(re.sub(r'<[^>]+>', '', re.sub(r'<br[^>]*>', '\n', cell)))
    chunks = text.split('\n') if JAPANESE.search(plain) else [' '.join(text.split())]
    out = []
    for line in chunks:
        line = ' '.join(line.split())
        if not line or not HANGUL.search(line) or JAPANESE.search(line):
            continue
        if JUNK.search(line) or NOT_DIALOGUE.search(line) or len(line) > 120:
            continue
        out.append(' '.join(FOOTNOTE.sub('', line).split()))
    return out


def main():
    roster = persona_common.roster()
    missing = [key for key, _ in PAGES if key not in roster]
    if missing:
        print('characters.json에 없는 id:', missing, file=sys.stderr)
        return 1
    if len(PAGES) != len(roster):
        print('PAGES가 로스터와 다릅니다. 빠진 id:', [k for k in roster if k not in dict(PAGES)], file=sys.stderr)
        return 1

    data = {}
    for key, page in PAGES:
        body = fetch(page)
        seen, lines = set(), []
        for label, cell in rows(body):
            for line in korean_lines(cell):
                if line in seen:
                    continue
                seen.add(line)
                lines.append({'label': label, 'text': line})
        data[key] = lines
        print(f'{key:9s} {len(lines):3d}  {lines[0]["text"][:44] if lines else "(없음)"}')
    path, counts = persona_common.write(
        'lines.json', 'namu.wiki 캐릭터 문서 대사 문단 (KR 로컬라이제이션)', data,
        lines=sum(len(v) for v in data.values()))
    print(f"{path} · 캐릭터 {counts['characters']}명 · 대사 {counts['lines']}줄")
    return 0
    print('wrote', OUT)
    return 0


if __name__ == '__main__':
    sys.exit(main())
