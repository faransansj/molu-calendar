#!/usr/bin/env python3
"""페르소나 데이터셋 벤더가 공유하는 것.

로스터는 characters.json 하나에서 온다. 캐릭터를 추가하면 벤더 스크립트를
고치지 않아도 된다. 저장 형식도 여기서 맞춘다.
"""
import io
import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PERSONA = os.path.join(ROOT, 'public/resource', 'persona')
CHARACTERS = os.path.join(PERSONA, 'characters.json')
LFS_CACHE = '/tmp/ba-lfs'


def lfs_fetch(repo, branch, path):
    """git-lfs 저장소에서 파일 하나만 받는다. 받은 파일은 캐시한다.

    테이블이 150MB대라 전체 clone 은 낭비다. 포인터를 읽고 해당 객체만 요청한다.
    """
    os.makedirs(LFS_CACHE, exist_ok=True)
    cached = os.path.join(LFS_CACHE, os.path.basename(path))
    if os.path.exists(cached) and os.path.getsize(cached) > 1024:
        return cached
    pointer = urllib.request.urlopen(
        f'https://raw.githubusercontent.com/{repo}/{branch}/{path}', timeout=60).read().decode()
    oid = pointer.split('sha256:')[1].split('\n')[0]
    size = int(pointer.split('size ')[1].split('\n')[0])
    body = json.dumps({'operation': 'download', 'transfers': ['basic'],
                       'objects': [{'oid': oid, 'size': size}]}).encode()
    request = urllib.request.Request(
        f'https://github.com/{repo}.git/info/lfs/objects/batch', data=body,
        headers={'Accept': 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json'})
    href = json.loads(urllib.request.urlopen(request, timeout=60).read())['objects'][0]['actions']['download']['href']
    print(f'  내려받는 중 {path} ({size / 1e6:.1f}MB)')
    with urllib.request.urlopen(href, timeout=1800) as response, open(cached, 'wb') as handle:
        while chunk := response.read(1 << 20):
            handle.write(chunk)
    return cached


def roster():
    """{id: 한국어 이름}. characters.json의 name이 게임 데이터의 화자 이름이다."""
    with io.open(CHARACTERS, encoding='utf-8') as handle:
        data = json.load(handle)
    return {persona['id']: persona['name'] for persona in data['characters']}


def write(filename, source, characters, **units):
    """`counts` 헤더와 id 키로 통일해 저장한다.

    units 는 파일마다 다른 단위 수치다(예: lines=2946, pairs=140).
    """
    payload = {
        'version': 1,
        'source': source,
        'counts': {'characters': len(characters), **units},
        'characters': characters,
    }
    path = os.path.join(PERSONA, filename)
    with io.open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    return path, payload['counts']
