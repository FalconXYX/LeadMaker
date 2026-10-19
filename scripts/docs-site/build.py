"""Build docs/index.html: one browsable page with DESIGN.md and the docs/ markdown files (a straight conversion).

Run: .venv/bin/python scripts/docs-site/build.py   (needs the `markdown` package, in the dev extras)
"""
import base64, html, json, re, sys, zlib
from pathlib import Path

import markdown

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / 'docs' / 'index.html'

DOCS = [  # (anchor id, nav label, candidate paths)
    ('design', 'Design', ['DESIGN.md', 'docs/DESIGN.md']),
    ('requirements', 'Requirements', ['docs/OpeningRequirements.MD']),
    ('system', 'System design', ['docs/SystemDesign.md']),
    ('performance', 'Performance', ['docs/Performance.md']),
]

IFRAME = re.compile(r'(?:-{3}\s*)?<iframe[^>]*src="https://mermaid\.live/embed\?[^"#]*#pako:([^"]+)"[^>]*>(?:\s*</iframe>)?')
FENCE = re.compile(r'^```mermaid\s*\n(.*?)\n```\s*$', re.S | re.M)
STATUS = {'Built': 'built', 'Demo': 'demo', 'Designed': 'designed', 'Partial': 'demo', 'Not built': 'designed'}


def decode_pako(payload: str) -> str:
    payload += '=' * (-len(payload) % 4)
    return json.loads(zlib.decompress(base64.urlsafe_b64decode(payload)))['code']


def slug(text: str) -> str:
    s = re.sub(r'<[^>]+>', '', text)
    s = html.unescape(s).lower()
    s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')
    return s or 'section'


def convert(doc_id: str, text: str):
    diagrams = []

    def stash(code: str) -> str:
        diagrams.append(code)
        return f'\n\nMERMAIDPLACEHOLDER{len(diagrams) - 1}\n\n'

    text = IFRAME.sub(lambda m: stash(decode_pako(m.group(1))), text)
    text = FENCE.sub(lambda m: stash(m.group(1)), text)

    body = markdown.markdown(text, extensions=['tables', 'fenced_code', 'sane_lists'])

    for i, code in enumerate(diagrams):
        block = f'<div class="diagram"><pre class="mermaid">{html.escape(code)}</pre></div>'
        body = re.sub(rf'<p>\s*MERMAIDPLACEHOLDER{i}\s*</p>', lambda _: block, body)

    # Heading ids (prefixed per doc) and the section list for the sidebar.
    toc, seen = [], set()

    def head(m):
        level, inner = m.group(1), m.group(2)
        hid = f'{doc_id}-{slug(inner)}'
        while hid in seen:
            hid += '-x'
        seen.add(hid)
        if level in ('2', '3'):
            toc.append((int(level), html.unescape(re.sub(r'<[^>]+>', '', inner)), hid))
        return f'<h{level} id="{hid}">{inner}</h{level}>'

    body = re.sub(r'<h([1-4])>(.*?)</h\1>', head, body)
    # Status cells in tables become pills.
    body = re.sub(r'<td>(Built|Demo|Designed|Partial|Not built)</td>',
                  lambda m: f'<td><span class="pill {STATUS[m.group(1)]}">{m.group(1)}</span></td>', body)
    # Wide tables scroll in their own box.
    body = body.replace('<table>', '<div class="table-wrap"><table>').replace('</table>', '</table></div>')
    return body, toc


def main():
    sections, nav = [], []
    for doc_id, label, paths in DOCS:
        path = next((REPO / p for p in paths if (REPO / p).exists()), None)
        if path is None:
            print(f'skip {label}: not found', file=sys.stderr)
            continue
        body, toc = convert(doc_id, path.read_text())
        sections.append(f'<article class="doc" id="{doc_id}" data-label="{label}">'
                        f'<div class="doc-meta">{html.escape(str(path.relative_to(REPO)))}</div>{body}</article>')
        items = ''.join(f'<li class="l{lvl}"><a href="#{doc_id}" data-target="{hid}">{html.escape(t)}</a></li>'
                        for lvl, t, hid in toc)
        nav.append(f'<div class="nav-doc" data-doc="{doc_id}"><a class="nav-doc-title" href="#{doc_id}" '
                   f'data-target="{doc_id}">{label}</a><ul>{items}</ul></div>')
        print(f'{label}: {path.relative_to(REPO)} ({len(toc)} sections)', file=sys.stderr)

    tabs = ''.join(f'<a class="tab" href="#{d}" data-target="{d}">{l}</a>'
                   for d, l, _ in DOCS if f'id="{d}"' in ''.join(sections))
    page = (Path(__file__).with_name('template.html').read_text()
            .replace('{{TABS}}', tabs).replace('{{NAV}}', ''.join(nav)).replace('{{DOCS}}', ''.join(sections)))
    OUT.write_text(page)
    print(f'wrote {OUT} ({len(page) // 1024} KB)', file=sys.stderr)


if __name__ == '__main__':
    main()
