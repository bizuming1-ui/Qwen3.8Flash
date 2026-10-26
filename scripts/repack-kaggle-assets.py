#!/usr/bin/env python3
"""Re-pack edited replica/source assets into the complete one-cell Kaggle notebook.

Updates the embedded FILES literal in kaggle.py, synchronizes the lone .ipynb cell,
then invokes scripts/extract-kaggle-assets.py to re-verify and regenerate replica/.
The generated Kaggle code remains the source of truth; hashes are always recomputed.
"""
from __future__ import annotations
import ast
import base64
import hashlib
import json
import pprint
import subprocess
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NB_DIR = ROOT / 'kaggle_workspace' / 'notebooks'
PY_PATH = NB_DIR / 'kaggle.py'
IPYNB_PATH = NB_DIR / 'kaggle.ipynb'
SOURCE = ROOT / 'replica' / 'source'


def main() -> None:
    source = PY_PATH.read_text(encoding='utf-8')
    tree = ast.parse(source)
    assignment = next((n for n in tree.body if isinstance(n, ast.Assign) and
                       any(isinstance(t, ast.Name) and t.id == 'FILES' for t in n.targets)), None)
    if assignment is None:
        raise SystemExit('Could not find FILES = {...} in kaggle.py')
    files = ast.literal_eval(assignment.value)
    changed = 0
    for rel, item in files.items():
        path = SOURCE / rel
        if not path.is_file():
            continue
        data = path.read_bytes()
        old = zlib.decompress(base64.b64decode(item['data']))
        if data == old:
            continue
        item['bytes'] = len(data)
        item['sha256'] = hashlib.sha256(data).hexdigest()
        item['data'] = base64.b64encode(zlib.compress(data, 9)).decode('ascii')
        changed += 1
    if changed:
        replacement = 'FILES = ' + pprint.pformat(files, width=110, sort_dicts=False)
        lines = source.splitlines(keepends=True)
        lines[assignment.lineno - 1:assignment.end_lineno] = [replacement + '\n']
        source = ''.join(lines)
        PY_PATH.write_text(source, encoding='utf-8')

    notebook = json.loads(IPYNB_PATH.read_text(encoding='utf-8'))
    cells = [c for c in notebook.get('cells', []) if c.get('cell_type') == 'code']
    if len(cells) != 1:
        raise SystemExit(f'Expected one code cell, found {len(cells)}')
    marker = source.find('# %%\n')
    if marker < 0:
        raise SystemExit('Could not find the single-cell marker in kaggle.py')
    cell_source = source[marker + len('# %%\n'):]
    # The export inserts one blank separator line after # %%; it is not part of
    # the Jupyter cell itself, whose source begins directly with the docstring.
    if cell_source.startswith('\n'):
        cell_source = cell_source[1:]
    cells[0]['source'] = cell_source.splitlines(keepends=True)
    IPYNB_PATH.write_text(json.dumps(notebook, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Repacked {changed} edited asset(s) into kaggle.py and kaggle.ipynb.')
    subprocess.run([sys.executable, str(ROOT / 'scripts' / 'extract-kaggle-assets.py')], cwd=ROOT, check=True)


if __name__ == '__main__':
    main()
