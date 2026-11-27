# 국립국어원 한국어기초사전·표준국어대사전·우리말샘(CC BY-SA 2.0 KR) XML → 앱용 용례 사전 조각(JSON)
# 쓰는 법: python3 tools/build-usage.py <한국어기초사전 xml 폴더> <표준국어대사전 xml 폴더> <우리말샘 xml 폴더> public/dict/2611
# 사전이 직접 지은 예문만 넣는다. 출판물·신문에서 인용한 예문(출처가 붙은 것)은 자유 이용 허락이 아니므로 넣지 않는다.
# 출력: <출력 폴더>/u/000~511.json = { 낱말: [ { d: 뜻풀이, p: 품사, k: 'k'|'s'|'o'(사전), g: [구], e: [문장], t: [[대화 두 줄]] } ] }
import sys, glob, json, re, os, zlib, io
import xml.etree.ElementTree as ET
from collections import defaultdict, Counter
KD, SD, OD, OUT = sys.argv[1:5]
NSH = 512
UNITS = {'어휘', '단어', '관용구', '속담'}
MAX_KEY = 120     # 낱말 하나에 넣는 용례 수 (구·문장·대화를 합쳐)
MAX_G, MAX_E, MAX_T = 12, 15, 4
def key(w): return re.sub(r'[\d\-^ ]', '', w or '')
def clean(t):
    if not t: return ''
    t = re.sub(r'<[^>]+>', '', t)
    return re.sub(r'\s+', ' ', t).strip()
def short(d): d = clean(d); return d if len(d) <= 90 else d[:88] + '…'
def norm(t): return re.sub(r'[\s{}.,!?"“”‘’\'·…~\-:;()]', '', t)
BAD = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
OLD = re.compile(r'[ᄀ-ᇿㅤ-ㆎꥠ-꥿ힰ-퟿〮〯]')  # 옛한글
def ok(t): return t and 3 <= len(t) <= 200 and re.search('[가-힣]', t) and not OLD.search(t)

data = defaultdict(list)   # key → [group]
seen = defaultdict(set)    # key → 넣은 예문(견줌용)
count = Counter()
def add_group(k, grp):
    S = seen[k]
    out = {kk: v for kk, v in grp.items() if kk not in ('g', 'e', 't')}
    for f, cap in (('g', MAX_G), ('e', MAX_E), ('t', MAX_T)):
        L = []
        for x in grp.get(f, []):
            n = norm(x if isinstance(x, str) else ''.join(x))
            if not n or n in S: continue
            S.add(n); L.append(x)
            if len(L) >= cap: break
        if L: out[f] = L
    if any(f in out for f in ('g', 'e', 't')):
        data[k].append(out); count[grp['k']] += sum(len(out.get(f, [])) for f in ('g', 'e', 't'))

# ---------- 한국어기초사전: 구·문장·대화 예문 (모두 사전이 지은 것) ----------
for f in sorted(glob.glob(KD + '/*.xml')):
    for ev, el in ET.iterparse(io.BytesIO(BAD.sub('', open(f, encoding='utf-8').read()).encode())):
        if el.tag != 'LexicalEntry': continue
        feats = {x.get('att'): x.get('val') for x in el.findall('feat')}
        lemma = el.find('Lemma/feat[@att="writtenForm"]')
        if lemma is None or feats.get('lexicalUnit') not in ('단어', '관용구', '속담'): el.clear(); continue
        k = key(lemma.get('val'))
        pos = feats.get('partOfSpeech') or ''
        for s in el.findall('Sense'):
            sf = {x.get('att'): x.get('val') for x in s.findall('feat')}
            grp = {'d': short(sf.get('definition')), 'p': pos, 'k': 'k', 'g': [], 'e': [], 't': []}
            for ex in s.findall('SenseExample'):
                fe = ex.findall('feat')
                typ = next((x.get('val') for x in fe if x.get('att') == 'type'), '')
                xs = [clean(x.get('val')) for x in fe if x.get('att') == 'example']
                xs = [x for x in xs if ok(x)]
                if not xs: continue
                if typ == '구': grp['g'].append(xs[0])
                elif typ == '대화' and len(xs) >= 2: grp['t'].append(xs[:2])
                else: grp['e'].append(xs[0])
            add_group(k, grp)
        el.clear()
print('krdict', len(data), count, file=sys.stderr)

# ---------- 표준국어대사전: 출처 없는 예문만 ----------
def std_items(path):
    for ev, el in ET.iterparse(path):
        if el.tag == 'item': yield el
for f in sorted(glob.glob(SD + '/*.xml')):
    for el in std_items(f):
        w = el.find('word_info')
        if w is None: el.clear(); continue
        word = w.findtext('word') or ''
        if (w.findtext('word_unit') or '어휘') not in UNITS or not re.search('[가-힣]', word): el.clear(); continue
        k = key(word)
        for pi in w.findall('pos_info'):
            pos = pi.findtext('pos') or ''
            for s in pi.iter('sense_info'):
                if (s.findtext('type') or '일반어') != '일반어': continue
                e = []
                for x in s.findall('example_info'):
                    if x.find('source') is not None and (x.findtext('source') or '').strip(): continue
                    t = clean(x.findtext('example'))
                    if ok(t): e.append(t)
                if e: add_group(k, {'d': short(s.findtext('definition')), 'p': pos if pos != '품사 없음' else '', 'k': 's', 'e': e})
        el.clear()
print('stdict', len(data), count, file=sys.stderr)

# ---------- 우리말샘: 출처 없는 예문만 (표준국어대사전과 겹치는 것은 빠진다) ----------
for f in sorted(glob.glob(OD + '/*.xml')):
    for ev, el in ET.iterparse(f):
        if el.tag != 'item': continue
        w = el.find('wordInfo'); s = el.find('senseInfo')
        if w is None or s is None: el.clear(); continue
        word = w.findtext('word') or ''
        if w.findtext('word_unit') not in UNITS or s.findtext('type') != '일반어' or not re.search('[가-힣]', word): el.clear(); continue
        e = []
        for x in s.findall('example_info'):
            if (x.findtext('source') or '').strip(): continue
            t = clean(x.findtext('example'))
            if ok(t): e.append(t)
        if e:
            p = s.findtext('pos') or ''
            add_group(key(word), {'d': short(s.findtext('definition')), 'p': p if p != '품사 없음' else '', 'k': 'o', 'e': e})
        el.clear()
print('opendict', len(data), count, file=sys.stderr)

# ---------- 낱말마다 상한, 조각으로 나누어 쓰기 ----------
os.makedirs(OUT + '/u', exist_ok=True)
sh = [dict() for _ in range(NSH)]
total = 0
# 사전마다 몫을 먼저 나누고(기초사전이 다 차지하지 않게), 남은 자리는 앞에서부터 채운다
SHARE = {'k': 70, 's': 35, 'o': 15}
def take(groups, budget, limit):
    n = 0; out = []
    for g in groups:
        g2 = dict(g)
        for f in ('g', 'e', 't'):
            if f in g2:
                room = max(0, min(budget.get(g['k'], limit), limit - n)) if budget else max(0, limit - n)
                g2[f] = g2[f][:room]
                n += len(g2[f])
                if budget: budget[g['k']] -= len(g2[f])
                if not g2[f]: del g2[f]
        out.append(g2)
    return out, n
for k, groups in data.items():
    first, n = take(groups, dict(SHARE), MAX_KEY)
    if n < MAX_KEY:  # 남은 자리: 몫에서 빠진 것을 앞에서부터
        rest = []
        for g, g1 in zip(groups, first):
            r = {kk: v for kk, v in g.items() if kk not in ('g', 'e', 't')}
            for f in ('g', 'e', 't'):
                if f in g: r[f] = g[f][len(g1.get(f, [])):]
            rest.append(r)
        more, m = take(rest, None, MAX_KEY - n)
        for g1, r in zip(first, more):
            for f in ('g', 'e', 't'):
                if r.get(f): g1[f] = g1.get(f, []) + r[f]
        n += m
    out = []
    for g1 in first:
        g1 = {kk: v for kk, v in g1.items() if kk not in ('g', 'e', 't') or v}
        if any(f in g1 for f in ('g', 'e', 't')): out.append(g1)
    total += n
    sh[zlib.crc32(k.encode()) % NSH][k] = out
size = 0
for i, d in enumerate(sh):
    s = json.dumps(d, ensure_ascii=False, separators=(',', ':'))
    size += len(s.encode())
    open(f'{OUT}/u/{i:03d}.json', 'w', encoding='utf-8').write(s)
print('words', len(data), 'examples', total, 'MB', round(size / 1e6, 1), file=sys.stderr)
