#!/usr/bin/env python3
"""게임 테이블에서 실제 모모톡 대화를 뽑는다.

feilongproject/ba-data (JP 브랜치)의 테이블은 git-lfs라 LFS API로 해당 파일만 받는다.
- DB/AcademyMessangerExcelTable.json     : 모모톡 메시지 16,886개 (MessageKR 포함)
- DB/LocalizeCharProfileExcelTable.json  : CharacterId → 한국어 이름

메시지 구조:
  MessageCondition  FavorRankUp/None → 학생 발화
                    Answer           → 선생님 선택지 (한 그룹에 2~4개)
                    Feedback         → 선택 뒤 학생 응답
  NextGroupId       다음 그룹. 선택지들은 같은 그룹으로 모여 분기가 다시 합쳐진다.

선택지 뒤 Feedback은 선택 분기가 아니라 학생이 연속으로 보낸 메시지다.
("무, 무슨 생각하는 거야!" / "데이트 같은 게 아니야!" / "업무라고, 업무!")
선택지들은 같은 NextGroupId로 모이므로 어느 쪽을 골라도 응답은 같다.
따라서 한 그룹의 선택지 전부와 다음 그룹의 Feedback 전부를 한 쌍으로 묶는다.

Run:  python3 tools/vendor/vendor_momotalk.py
"""
import collections
import io
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import persona_common

CACHE = '/tmp/ba-lfs'
REPO = 'feilongproject/ba-data'
BRANCH = 'JP'
TABLES = {
    'messages': 'DB/AcademyMessangerExcelTable.json',
    'profiles': 'DB/LocalizeCharProfileExcelTable.json',
}


def fetch(path):
    """LFS 포인터를 읽고 실제 객체를 받는다. 받은 파일은 캐시한다."""
    os.makedirs(CACHE, exist_ok=True)
    cached = os.path.join(CACHE, os.path.basename(path))
    if os.path.exists(cached) and os.path.getsize(cached) > 1024:
        return json.load(io.open(cached, encoding='utf-8'))

    pointer = urllib.request.urlopen(
        f'https://raw.githubusercontent.com/{REPO}/{BRANCH}/{path}', timeout=60).read().decode()
    oid = pointer.split('sha256:')[1].split('\n')[0]
    size = int(pointer.split('size ')[1].split('\n')[0])
    body = json.dumps({'operation': 'download', 'transfers': ['basic'],
                       'objects': [{'oid': oid, 'size': size}]}).encode()
    request = urllib.request.Request(
        f'https://github.com/{REPO}.git/info/lfs/objects/batch', data=body,
        headers={'Accept': 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json'})
    href = json.loads(urllib.request.urlopen(request, timeout=60).read())['objects'][0]['actions']['download']['href']
    print(f'  내려받는 중 {path} ({size / 1e6:.1f}MB)')
    with urllib.request.urlopen(href, timeout=300) as response, open(cached, 'wb') as handle:
        handle.write(response.read())
    return json.load(io.open(cached, encoding='utf-8'))


def main():
    print('게임 테이블 준비')
    messages = fetch(TABLES['messages'])['DataList']
    profiles = fetch(TABLES['profiles'])['DataList']

    # 이름이 같은 시즈널(수영복 등)이 여러 CharacterId를 가진다. 모모톡이 가장 많은 쪽이 기본 학생이다.
    counts = collections.Counter(entry['CharacterId'] for entry in messages)
    by_name = collections.defaultdict(list)
    for profile in profiles:
        name = profile.get('PersonalNameKr') or profile.get('FullNameKr')
        if name:
            by_name[name].append(profile['CharacterId'])
    resolved = {name: max(ids, key=lambda cid: counts.get(cid, 0)) for name, ids in by_name.items()}

    groups = collections.defaultdict(list)
    for entry in messages:
        groups[entry['MessageGroupId']].append(entry)
    for items in groups.values():
        items.sort(key=lambda entry: entry['Id'])

    characters = {}
    for key, name in persona_common.roster().items():
        cid = resolved.get(name)
        if cid is None or not counts.get(cid):
            print(f'  {key:9s} {name:5s} 모모톡 없음')
            continue
        mine = {group: items for group, items in groups.items()
                if items[0]['CharacterId'] == cid}
        reached = {entry['NextGroupId'] for items in mine.values() for entry in items if entry['NextGroupId']}
        roots = sorted(group for group in mine if group not in reached)

        conversations, pairs = [], []
        for root in roots:
            chain, group = [], root
            while group in mine:
                items = mine[group]
                answers = [e for e in items if e['MessageCondition'] == 'Answer']
                for entry in items:
                    role = 'sensei' if entry['MessageCondition'] == 'Answer' else 'student'
                    text = (entry.get('MessageKR') or '').strip()
                    if text and entry['MessageType'] == 'Text':
                        chain.append({'role': role, 'text': text})
                nxt = items[0]['NextGroupId']
                if answers:
                    # 학생은 한 턴에 여러 메시지를 연속으로 보낸다. Feedback 그룹만 취하면
                    # 다음 그룹에서 이어 말하는 부분이 잘려 문장이 중간에 끊긴다.
                    # 다음 Answer 그룹이 나올 때까지 학생 메시지를 모은다.
                    reply, cursor, guard = [], nxt, 0
                    while cursor in mine and guard < 50:
                        if any(e['MessageCondition'] == 'Answer' for e in mine[cursor]):
                            break
                        reply += [e['MessageKR'].strip() for e in mine[cursor]
                                  if e['MessageCondition'] in ('Feedback', 'None') and (e.get('MessageKR') or '').strip()]
                        cursor = mine[cursor][0]['NextGroupId']
                        guard += 1
                    if reply:
                        pairs.append({
                            'sensei': [e['MessageKR'].strip() for e in answers],
                            'student': reply,
                        })
                group = nxt
            if len(chain) >= 2:
                conversations.append(chain)

        characters[key] = {'characterId': cid, 'pairs': pairs, 'conversations': conversations}
        print(f'  {key:9s} {name:5s} 대화 {len(conversations):3d}개 · 쌍 {len(pairs):3d}개')

    path, total = persona_common.write(
        'momotalk.json',
        (f'{REPO} {BRANCH} 브랜치의 {TABLES["messages"]} · {TABLES["profiles"]} (MessageKR). '
         'pairs는 (선생님 선택지 → 학생 연속 응답) 실제 모모톡 교환이다.'),
        characters,
        pairs=sum(len(c['pairs']) for c in characters.values()),
        conversations=sum(len(c['conversations']) for c in characters.values()))
    print(f"{path} · 캐릭터 {total['characters']}명 · 쌍 {total['pairs']}개")
    return 0


if __name__ == '__main__':
    sys.exit(main())
