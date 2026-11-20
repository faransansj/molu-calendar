#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""GPU-independent smoke for the actual MomoTalk UI using two tabs and a disposable profile."""
import argparse
import json
import re
import shutil
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright
from probe_browser_gemma import ARTIFACT, open_room


def button(page, name):
    return page.get_by_role('button', name=name, exact=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('--executable', default=shutil.which('chromium'))
    args = parser.parse_args()
    if urlsplit(args.url).hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('Only loopback previews are supported.')
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.executable)
        ctx = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        model_gets = []
        ctx.on('request', lambda r: model_gets.append(r.url) if ARTIFACT in r.url else None)
        a, b = ctx.new_page(), ctx.new_page()
        memory = '독서 모임은 금요일 오후 일곱 시예요.'
        try:
            for page in (a, b):
                page.goto(args.url, wait_until='domcontentloaded')
                open_room(page)
            # Missing model must not persist a dangling question, download, or discard the draft.
            a.get_by_label('메시지 입력').fill('이 초안을 보존해 줘.')
            button(a, '전송').click()
            expect(a.get_by_role('alert')).to_contain_text('모델')
            expect(a.get_by_label('메시지 입력')).to_have_value('이 초안을 보존해 줘.')
            for name, expected in [('무츠키', ''), ('아로나', '이 초안을 보존해 줘.')]:
                button(a, '대화 목록으로').click()
                button(a, '친구').click()
                a.get_by_label('학생 검색').fill(name)
                a.get_by_label('학생 목록').get_by_role('button', name=re.compile('^' + name + ' ')).first.click()
                button(a, '대화 시작').click()
                expect(a.get_by_label('메시지 입력')).to_have_value(expected)
                if not expected:
                    a.get_by_label('메시지 입력').fill('두 번째 방의 초안')
            for page in (a, b):
                page.get_by_role('button', name=re.compile('^아로나의 기억')).click()
            a.get_by_label('새 기억').fill(memory)
            button(a, '추가').click()
            expect(b.get_by_text(memory, exact=True)).to_be_visible()
            button(a, 'MOLU 설정').click()
            with a.expect_download() as event:
                button(a, '내보내기').click()
            path = event.value.path()
            backup = json.loads(path.read_text())
            assert [r['id'] for r in backup['rooms']] == ['Arona'] and backup['messages'] == []
            assert [(m['roomId'], m['text']) for m in backup['memories']] == [('Arona', memory)]
            settings = a.get_by_role('dialog', name='MOLU 설정')
            # Delete the room itself, not the entire database; verify another open memory panel updates.
            button(settings, '닫기').click()
            a.get_by_role('button', name=re.compile('^아로나의 기억')).click()
            expect(a.get_by_label('메시지 입력')).to_have_value('이 초안을 보존해 줘.')
            button(a, '아로나 프로필').click()
            button(a, '대화 지우기').click()
            a.get_by_role('group', name='이 대화와 기억을 지울까요?').get_by_role('button', name='삭제').click()
            expect(b.get_by_text(memory, exact=True)).to_have_count(0)
            button(a, 'MOLU 설정').click()
            settings.locator('input[type=file]').set_input_files({'name':'chat.json', 'mimeType':'application/json', 'buffer':path.read_bytes()})
            button(settings, '백업으로 바꾸기').click()
            expect(settings.get_by_text('백업을 복원했어요.', exact=True)).to_be_visible()
            expect(b.get_by_text(memory, exact=True)).to_be_visible()
            assert not model_gets, model_gets
            print('PASS: cache-only miss preserves draft; first memory/backup round trip; room delete and restore synchronize across tabs')
        finally:
            browser.close()


if __name__ == '__main__':
    main()
