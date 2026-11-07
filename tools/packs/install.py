# Copy a built pack into the app (public/samples/<car>/) with CC BY credits in the manifest,
# and regenerate public/samples/CREDITS.md for all installed packs.
# usage: python3 -P install.py <packs_root> <app_root> <car> [<car> ...]
import sys, os, json, shutil, re, html

S = os.path.dirname(os.path.abspath(__file__))
meta = {os.path.basename(e['file']): e for e in json.load(open(os.path.join(S, 'commons.json'))) if 'file' in e}
if not meta:  # commons.json entries saved before 'file' was added: derive the key from the title
    for e in json.load(open(os.path.join(S, 'commons.json'))):
        m = re.search(r'YouTube ([^)]+)\)', e['title'])
        if m: meta[m.group(1).replace(' ', '_').replace('-', '') + '.opus'] = e

root, app, cars = sys.argv[1], sys.argv[2], sys.argv[3:]


def strip(h):
    return html.unescape(re.sub(r'<[^>]+>', '', h or '')).strip()


for car in cars:
    src, dst = os.path.join(root, car), os.path.join(app, 'public', 'samples', car)
    m = json.load(open(os.path.join(src, 'manifest.json')))
    if os.path.isdir(dst): shutil.rmtree(dst)
    os.makedirs(dst)
    used = sorted({l.pop('source') for l in m['loops'] if 'source' in l})
    for l in m['loops']:
        shutil.copy(os.path.join(src, l['file']), os.path.join(dst, l['file']))
    credits = []
    for k in used:
        e = meta[k]
        credits.append(dict(title=e['title'].removeprefix('File:').rsplit('.', 1)[0],
                            author=strip(e['artist']).removesuffix(' (YouTube)'),
                            license=e['lic'],
                            url='https://commons.wikimedia.org/wiki/' + e['title'].replace(' ', '_'),
                            changes='excerpts pitch-flattened to constant rpm, looped, level-matched'))
    m['credits'] = credits
    json.dump(m, open(os.path.join(dst, 'manifest.json'), 'w'), indent=1, ensure_ascii=False)
    print(car, len(m['loops']), 'loops from', ', '.join(c['author'] for c in credits))

# CREDITS.md for everything installed
out = ['# Recorded sound packs: credits', '',
       'Each pack is made from short excerpts of the recordings below, pitch-flattened to a constant',
       'rpm, looped and level-matched (see `tools/packs/`). The recordings are licensed under the',
       'Creative Commons Attribution 3.0 licence (https://creativecommons.org/licenses/by/3.0/).', '']
sd = os.path.join(app, 'public', 'samples')
for car in sorted(os.listdir(sd)):
    mf = os.path.join(sd, car, 'manifest.json')
    if not os.path.isfile(mf): continue
    out.append(f'## {car}')
    for c in json.load(open(mf)).get('credits', []):
        out.append(f"- \"{c['title']}\" by {c['author']}, {c['license']}, {c['url']} (changes: {c['changes']})")
    out.append('')
open(os.path.join(sd, 'CREDITS.md'), 'w').write('\n'.join(out))
