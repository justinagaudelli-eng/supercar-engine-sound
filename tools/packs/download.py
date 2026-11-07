# Download the source recordings listed in commons.json into tools/packs/rec/ (slowly: Wikimedia
# rate-limits bulk downloads). usage: python3 -P tools/packs/download.py
import json, os, re, time, urllib.request, urllib.parse
D = os.path.dirname(os.path.abspath(__file__)); os.makedirs(os.path.join(D, 'rec'), exist_ok=True)
UA = {'User-Agent': 'engine-sound-pack-builder/1.0 (personal project)'}
for e in json.load(open(os.path.join(D, 'commons.json'))):
    m = re.search(r'YouTube ([^)]+)\)', e['title'])
    if not m: continue
    fn = os.path.join(D, 'rec', m.group(1).replace(' ', '_').replace('-', '') + '.opus')
    while not (os.path.exists(fn) and os.path.getsize(fn) > 0):
        try:
            data = urllib.request.urlopen(urllib.request.Request(e['url'].split('?')[0], headers=UA)).read()
            open(fn, 'wb').write(data); print('got', os.path.basename(fn))
        except Exception as x:
            print('waiting (', x, ')'); time.sleep(60)
    time.sleep(5)
