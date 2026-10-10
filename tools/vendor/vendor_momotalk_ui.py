"""Download MomoTalk UI assets for local use.

Sources:
  - pizza-studio/momotalk (GH) : BG_MainOffice.jpg  (Schale office backdrop used behind the app window)
  - bluearchive.wiki           : SE_MomoTalk_01.wav (in-game MomoTalk notification sound)

Run:  python3 tools/vendor/vendor_momotalk_ui.py
Writes: public/resource/momotalk/ui/{BG_MainOffice.jpg, SE_MomoTalk_01.wav}
"""

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UI_DIR = os.path.join(ROOT, 'public', 'resource', 'momotalk', 'ui')

ASSETS = {
    'BG_MainOffice.jpg': 'https://raw.githubusercontent.com/pizza-studio/momotalk/main/public/BG_MainOffice.jpg',
    'SE_MomoTalk_01.wav': 'https://static.wikitide.net/bluearchivewiki/0/00/SE_MomoTalk_01.wav',
}


def fetch(name, url):
    path = os.path.join(UI_DIR, name)
    if os.path.exists(path) and os.path.getsize(path) > 1024:
        print(f'  kept {name}')
        return
    subprocess.run(['curl', '-sL', '-o', path, url], check=True)
    if not os.path.exists(path) or os.path.getsize(path) < 1024:
        sys.exit(f'failed to download {name}')
    print(f'  wrote {name} ({os.path.getsize(path) // 1024} KB)')


if __name__ == '__main__':
    os.makedirs(UI_DIR, exist_ok=True)
    for name, url in ASSETS.items():
        fetch(name, url)
