"""One-off vendoring of Blue Archive student profile data.

Sources:
  - blue-utils.me    : KR-localized profile (school/year/club, MomoTalk status message, hobby, intro, CV)
  - SchaleDB         : 120x120 student icons (images/student/icon/<characterId>.webp)
  - closure-talk     : same-style icons for students SchaleDB skips
  - bluearchive.wiki : Portrait_<Name>.png, last resort for KR/JP-only students neither has

Run:  python3 tools/vendor/vendor_students.py
Writes: public/resource/momotalk/students.json and avatars
Not part of the app runtime; re-run only to refresh the roster.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(ROOT, 'public/resource', 'momotalk')
CACHE = '/tmp/bu-cache'
LIST_URL = 'https://blue-utils.me/student/list?lang=Kr&server=kr'
DETAIL_URL = 'https://blue-utils.me/student-detail/{slug}?lang=Kr&server=kr'
SCHALE_ICON = 'https://raw.githubusercontent.com/SchaleDB/SchaleDB/main/images/student/icon/{cid}.webp'
WIKI_API = 'https://bluearchive.wiki/w/api.php'
ICON_DIR = os.path.join(CACHE, 'icons')
UA = 'molu-calendar-vendoring (one-off fan project data build)'
DELAY = 0.8


def fetch(url, path, tries=4):
    if valid(path):
        return path
    for attempt in range(tries):
        result = subprocess.run(
            ['curl', '-sL', '--max-time', '40', '-A', UA, '-w', '%{http_code}', '-o', path, url],
            capture_output=True, text=True, check=False)
        if result.stdout.strip() == '200' and valid(path):
            return path
        if os.path.exists(path):
            os.remove(path)
        time.sleep(15 * (attempt + 1))
    return None


def valid(path):
    return bool(path) and os.path.exists(path) and os.path.getsize(path) > 3000


def roster():
    """Base students (seasonal variants excluded) from the KR student list payload."""
    path = fetch(LIST_URL, os.path.join(CACHE, 'list.html'))
    if not path:
        sys.exit('failed to load student list')
    html = open(path, encoding='utf-8', errors='replace').read().encode('utf-8').decode('unicode_escape')
    entries = []
    for match in re.finditer(r'\[\s*\{[^\[\]]*"devName".*?\}\s*\]', html, re.S):
        try:
            entries += json.loads(match.group(0))
        except Exception:
            continue
    base = {}
    for entry in entries:
        if entry.get('seasonalCode'):
            continue
        entry['id'] = entry['devName'].replace('_default', '')
        base[entry['id']] = entry
    return base


def text(value):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', value)).strip()


def profile(slug):
    path = fetch(DETAIL_URL.format(slug=slug), os.path.join(CACHE, f'{slug}.html'))
    if not path:
        return {}
    html = open(path, encoding='utf-8', errors='replace').read()
    talk = re.findall(r'box-talk-text[^>]*>\s*<p>([^<]*)</p>', html)
    school = re.findall(r'box-school-text[^>]*>\s*<p>([^<]+)</p>\s*<p>([^<]+)</p>', html)
    rows = {text(key): text(value) for key, value in re.findall(r'<th>([^<]+)</th>\s*<td>(.*?)</td>', html, re.S)}
    data = {
        'status': text(talk[0]) if talk else '',
        'birthday': rows.get('생일', ''),
        'age': rows.get('나이', ''),
        'height': rows.get('키', ''),
        'hobby': rows.get('취미', ''),
        'illust': rows.get('일러스트', ''),
        'intro': rows.get('소개', ''),
        'voice': '',
    }
    if school:
        year = re.search(r'\s+(\S*학년)$', school[0][0])
        data['school'] = text(school[0][0].replace(year.group(0), '')) if year else text(school[0][0])
        data['year'] = year.group(1) if year else ''
        data['club'] = text(school[0][1])
    voices = re.findall(r'flag/kr\.svg">\s*<span>([^<]+)</span>', html)
    if voices:
        data['voice'] = text(voices[0])
    return data


def closure_talk_icons():
    """Korean name -> avatar image id, from closure-talk's Blue Archive data set."""
    path = fetch('https://closuretalk.github.io/resources/ba/char.json', os.path.join(CACHE, 'ct-char.json'))
    if not path:
        return {}
    index = {}
    for char in json.load(open(path, encoding='utf-8')):
        images = char.get('images') or []
        if not images:
            continue
        image = char['id'] if char['id'] in images else images[0]
        for key in ((char.get('names') or {}).get('ko'), (char.get('short_names') or {}).get('ko')):
            if key:
                index.setdefault(key, image)
    return index


def wiki_portrait(entry):
    """bluearchive.wiki Portrait_<Name>.png; the only source left for KR/JP-only students."""
    title = f"File:Portrait_{entry['slug'].capitalize()}.png"
    result = subprocess.run(
        ['curl', '-sL', '--max-time', '30', '-A', UA,
         f'{WIKI_API}?action=query&titles={title}&prop=imageinfo&iiprop=url&format=json'],
        capture_output=True, text=True, check=False)
    try:
        pages = json.loads(result.stdout)['query']['pages']
    except (ValueError, KeyError):
        return ''
    info = next(iter(pages.values())).get('imageinfo')
    if not info:
        return ''
    name = f"{entry['id']}.png"
    if fetch(info[0]['url'], os.path.join(OUT_DIR, name)):
        return name
    return ''


def avatar(entry, icon_dir, ct_index):
    """Try SchaleDB, closure-talk, then wiki portraits; the UI handles missing avatars."""
    name = entry['id']
    icon = os.path.join(icon_dir, f"{entry['characterId']}.webp")
    if os.path.exists(icon) and os.path.getsize(icon) > 200:
        shutil.copyfile(icon, os.path.join(OUT_DIR, f'{name}.webp'))
        return f'{name}.webp'
    image = ct_index.get(entry['fullName']) or ct_index.get(entry['fullName'].split()[-1])
    if image:
        url = f'https://closuretalk.github.io/resources/ba/characters/{image}.webp'
        target = os.path.join(CACHE, f'ct-{name}.webp')
        if fetch(url, target) and os.path.getsize(target) > 500:
            shutil.copyfile(target, os.path.join(OUT_DIR, f'{name}.webp'))
            return f'{name}.webp'
    return wiki_portrait(entry)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    base = roster()
    print(f'roster: {len(base)} base students')

    with ThreadPoolExecutor(max_workers=2) as pool:
        profiles = []
        for slug, data in zip((item[1]['slug'] for item in base.items()), pool.map(lambda item: profile(item[1]['slug']), base.items())):
            profiles.append(data)
            time.sleep(DELAY)

    students = []
    missing_avatar = []
    ct_index = closure_talk_icons()
    for (name, entry), extra in zip(base.items(), profiles):
        if not extra:
            print(f'  ! no detail page: {name}')
            continue
        students.append({
            'id': name,
            'img': avatar(entry, ICON_DIR, ct_index),
            'name': entry['fullName'],
            'short': entry['fullName'].split()[-1],
            'school': extra.get('school', ''),
            'year': extra.get('year', ''),
            'club': extra.get('club', ''),
            'status': extra.get('status', ''),
            'birthday': extra.get('birthday', ''),
            'age': extra.get('age', ''),
            'height': extra.get('height', ''),
            'hobby': extra.get('hobby', ''),
            'illust': extra.get('illust', ''),
            'voice': extra.get('voice', ''),
            'intro': extra.get('intro', ''),
        })
        if not students[-1]['img']:
            missing_avatar.append(name)

    students.sort(key=lambda s: (s['school'], s['short']))
    with open(os.path.join(OUT_DIR, 'students.json'), 'w', encoding='utf-8') as handle:
        json.dump(students, handle, ensure_ascii=False, indent=1)
        handle.write('\n')
    print(f'wrote {len(students)} students')
    print(f'no avatar: {len(missing_avatar)} {missing_avatar[:10]}')
    print(f'no status: {sum(1 for s in students if not s["status"])}')


if __name__ == '__main__':
    main()
