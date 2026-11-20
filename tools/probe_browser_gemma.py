#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""Exercise the released app, real Worker, model download and IndexedDB in an isolated browser.

Run against a local production preview. Installs no model in a user's browser profile.
Raw Korean answers are reported for semantic review, not graded by keyword presence.
"""
import argparse
from contextlib import nullcontext
import json
import re
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

QUESTION = "내가 어제 점심에 무엇을 먹었다고 했는지 기억해?"
FOLLOW_UP = "한국어로 짧게 인사해 줘."
ARTIFACT = "gemma-4-E2B-it-web.litertlm"
PINNED_BYTES = 2_008_432_640


def cache_bytes(page):
    """Read back the committed response in chunks without allocating a model-sized buffer."""
    return page.evaluate("""async file => {
      const name = 'molu/litert-model-v1';
      if (!await caches.has(name)) return 0;
      const cache = await caches.open(name);
      const key = (await cache.keys()).find(r => new URL(r.url).pathname.endsWith('/' + file));
      if (!key) return 0;
      const stream = (await cache.match(key)).body.getReader();
      let total = 0;
      for (;;) {
        const {done, value} = await stream.read();
        if (done) return total;
        total += value.byteLength;
      }
    }""", ARTIFACT)


def open_room(page):
    page.get_by_role("button", name=re.compile("^모모톡 열기")).click()
    page.get_by_role("button", name="대화 시작", exact=True).click()
    expect(page.get_by_label("메시지 입력")).to_be_enabled()


def rows(page):
    return page.evaluate("""async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('molu-chat-memory');
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      try { return await new Promise((resolve, reject) => {
        const req = db.transaction('messages').objectStore('messages').index('roomSeq').getAll();
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      }); } finally { db.close(); }
    }""")


def generate(page, question, *, retry=False):
    before = rows(page)
    previous = sum(m["sourceKind"] == "model-output" for m in before)
    if not retry:
        page.get_by_label("메시지 입력").fill(question)
    start = time.monotonic()
    page.get_by_role("button", name="다시 시도" if retry else "전송", exact=True).click()
    # TTFT here measures the first nonempty *visible answer*, including app overhead.
    page.wait_for_function("""previous => {
      const log = document.querySelector('[role="log"]');
      return !!log?.querySelector('[role="status"] p:last-of-type')?.textContent.trim()
        || (log?.querySelectorAll('[title="기기 안 AI가 만든 답장"]').length ?? 0) > previous
        || !!document.querySelector('dialog[open] [role="alert"], [role="dialog"] [role="alert"]');
    }""", arg=previous, timeout=240_000)
    first_ms = round((time.monotonic() - start) * 1000)
    alert = page.get_by_role('dialog').get_by_role('alert')
    if alert.count() and alert.first.is_visible():
        raise RuntimeError(alert.first.inner_text())
    expect(page.get_by_title("기기 안 AI가 만든 답장")).to_have_count(previous + 1, timeout=180_000)
    after = rows(page)
    additions = after[len(before):]
    assert [m['sourceKind'] for m in additions] == (['model-output'] if retry else ['user-input', 'model-output']), additions
    reply = additions[-1]
    assert reply['status'] == 'complete' and re.search('[가-힣]', reply['text']), reply
    return {'question': question, 'answer': reply['text'], 'visible_ttft_ms': first_ms,
            'completed_ms': round((time.monotonic() - start) * 1000), 'id': reply['id']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url', help='Local app URL, e.g. http://127.0.0.1:8787')
    parser.add_argument('--browser', choices=['chromium', 'firefox'], default='chromium')
    parser.add_argument('--executable', help='Chromium executable or Playwright-compatible Firefox')
    parser.add_argument('--flag', action='append', default=[], help='Repeat for explicit browser GPU flags; recorded in results')
    parser.add_argument('--profile-dir', type=Path, help='Keep evidence in this new, empty test profile')
    parser.add_argument('--headed', action='store_true')
    args = parser.parse_args()
    if urlsplit(args.url).hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('Only loopback previews are supported.')
    if args.profile_dir:
        args.profile_dir.mkdir(parents=True, exist_ok=True)
        if any(args.profile_dir.iterdir()):
            parser.error('--profile-dir must be empty; never use your personal profile.')
    report = {'browser': args.browser, 'flags': args.flag, 'answers': [], 'passed': False}
    # Use a fresh disk-backed profile. Incognito quotas are not representative for a 2 GB artifact.
    profile_dir = nullcontext(str(args.profile_dir.resolve())) if args.profile_dir else TemporaryDirectory(prefix='molu-gemma-')
    with profile_dir as profile, sync_playwright() as pw:
        ctx = getattr(pw, args.browser).launch_persistent_context(
            profile, executable_path=args.executable, headless=not args.headed,
            args=args.flag, viewport={'width': 1440, 'height': 1000})
        try:
            gets = []
            ctx.on('request', lambda r: gets.append(r.url) if r.method == 'GET' and urlsplit(r.url).path.endswith('/' + ARTIFACT) else None)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.set_default_timeout(30_000)
            report['browser_ua'] = page.evaluate('navigator.userAgent')
            page.goto(args.url, wait_until='domcontentloaded')
            report['gpu'] = page.evaluate("""async () => {
              const a = await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});
              return a ? {vendor:a.info.vendor, architecture:a.info.architecture,
                description:a.info.description, fallback:a.info.isFallbackAdapter} : null;
            }""")
            page.get_by_role('button', name='설정 열기', exact=True).click()
            settings = page.get_by_role('dialog', name='MOLU 설정')
            start = time.monotonic()
            settings.get_by_role('button', name='모델 받기').click()
            page.wait_for_function("""() => {
              const section = document.querySelector('[aria-labelledby="ai-settings"]');
              return section && (section.textContent.includes('준비됨 ·') || section.querySelector('[role="alert"]') ||
                section.querySelector('[aria-label="알림 닫기"]'));
            }""", timeout=620_000)
            expect(settings.get_by_text('준비됨 · 이 탭에서 바로 답장해요', exact=True)).to_be_visible(timeout=1000)
            report['cold_prepare_ms'] = round((time.monotonic() - start) * 1000)
            report['committed_bytes'] = cache_bytes(page)
            assert report['committed_bytes'] == PINNED_BYTES, 'Incomplete cached model'
            settings.get_by_role('button', name='닫기', exact=True).click()
            open_room(page)
            report['answers'].append(generate(page, QUESTION))
            saved = rows(page)
            assert saved and saved[-1]['text'] == report['answers'][0]['answer']
            report['cold_model_gets'] = len(gets)
            # A warm GET count of zero is only evidence if this browser observes cold Worker requests.
            if not gets:
                raise RuntimeError('No cold model GET observed; cannot verify warm-cache reuse.')
            page.reload(wait_until='domcontentloaded')
            open_room(page)
            assert rows(page) == saved, 'Transcript changed on reload'
            report['answers'].append(generate(page, FOLLOW_UP))
            report['warm_model_gets'] = len(gets) - report['cold_model_gets']
            assert report['warm_model_gets'] == 0, 'Unexpected model download on revisit'
            question = '아로나, 오늘은 어떻게 지냈어?'
            before = rows(page)
            page.get_by_label('메시지 입력').fill(question)
            page.get_by_role('button', name='전송', exact=True).click()
            expect(page.get_by_role('log').get_by_text(question, exact=True)).to_be_visible()
            page.get_by_role('button', name='중단', exact=True).click()
            expect(page.get_by_role('button', name='다시 시도', exact=True)).to_be_enabled()
            interrupted = rows(page)[len(before):]
            assert len(interrupted) == 1 and interrupted[0]['sourceKind'] == 'user-input', interrupted
            report['answers'].append(generate(page, question, retry=True))
            page.get_by_role('button', name='MOLU 설정', exact=True).click()
            settings.get_by_role('button', name='모델 파일 삭제', exact=True).click()
            settings.get_by_role('group', name=re.compile('받아 둔 .*지울까요')).get_by_role('button', name='삭제').click()
            expect(settings.get_by_role('button', name='모델 받기')).to_be_visible()
            assert cache_bytes(page) == 0, 'Model deletion did not remove the artifact'
            assert len(rows(page)) == len(before) + 2, 'Deleting the model changed the transcript'
            report['model_deletion'] = True
            report['passed'] = True
        except Exception as exc:
            report['error'] = str(exc)
            if 'page' in locals() and not page.is_closed():
                report['ui'] = page.locator('[aria-labelledby="ai-settings"], [role="alert"]').all_text_contents()
                report['observed_model_gets'] = len(gets)
                report['transcript'] = rows(page)
        finally:
            ctx.close()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
