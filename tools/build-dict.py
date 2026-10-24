# 우리말샘·한국어기초사전(국립국어원, CC BY-SA 2.0 KR) XML → 앱용 유의어 사전 조각(JSON)
# 쓰는 법: python3 build.py <우리말샘 xml 폴더> <한국어기초사전 xml 폴더> <출력 폴더>
import sys, glob, json, re, os, zlib
import xml.etree.ElementTree as ET
from collections import defaultdict, Counter
OD, KD, OUT = sys.argv[1:4]
NSH = 512
UNITS = {'어휘', '관용구', '속담'}
REL = {'비슷한말': 's', '반대말': 'a', '상위어': 'u', '하위어': 'l', '참고 어휘': 'r', '본말': 'b', '준말': 'j', '높임말': 'hi', '낮춤말': 'lo'}
KREL = {'유의어': 's', '반대말': 'a', '참고어': 'r', '큰말': 'v', '작은말': 'v', '센말': 'v', '여린말': 'v', '본말': 'b', '준말': 'j', '높임말': 'hi', '낮춤말': 'lo'}
def key(w): return re.sub(r'[\d\-^ ]', '', w)
def disp(w): return re.sub(r'\d+$', '', w).replace('-', '').replace('^', ' ')
def clean(t):
    if not t: return ''
    t = re.sub(r'<[^>]+>', '', t)
    return re.sub(r'\s+', ' ', t).strip()
def add(lst, x):
    if x and x not in lst: lst.append(x)

# ---------- 한국어기초사전: 기본 낱말 5만여 개의 유의어·반대말·예문·의미 갈래 ----------
kd = {}  # key → {s,a,r,v.., e: [], g: 갈래, p: 품사, f: [활용형]}
import io
BAD = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
for f in sorted(glob.glob(KD + '/*.xml')):
    for ev, el in ET.iterparse(io.BytesIO(BAD.sub('', open(f, encoding='utf-8').read()).encode())):
        if el.tag != 'LexicalEntry': continue
        feats = {x.get('att'): x.get('val') for x in el.findall('feat')}
        lemma = el.find('Lemma/feat[@att="writtenForm"]')
        if lemma is None or feats.get('lexicalUnit') != '단어': el.clear(); continue
        k = key(lemma.get('val'))
        d = kd.setdefault(k, {})
        if feats.get('semanticCategory') and feats['semanticCategory'] != '없음': d.setdefault('g', feats['semanticCategory'])
        if feats.get('partOfSpeech'): d.setdefault('p', feats['partOfSpeech'])
        for wf in el.findall('WordForm'):
            fe = {x.get('att'): x.get('val') for x in wf.findall('feat')}
            if fe.get('type') == '활용' and fe.get('writtenForm'): d.setdefault('f', []).append(fe['writtenForm'].replace(' ', ''))
        for s in el.findall('Sense'):
            for r in s.findall('SenseRelation'):
                fe = {x.get('att'): x.get('val') for x in r.findall('feat')}
                t = KREL.get(fe.get('type'))
                if t and fe.get('lemma'): add(d.setdefault(t, []), disp(fe['lemma']))
            for ex in s.findall('SenseExample'):
                fe = [x for x in ex.findall('feat')]
                if any(x.get('att') == 'type' and x.get('val') == '문장' for x in fe):
                    t = next((x.get('val') for x in fe if x.get('att') == 'example'), '')
                    if t and len(t) < 120 and len(d.setdefault('e', [])) < 3: d['e'].append(t.strip())
        el.clear()
print('krdict', len(kd), file=sys.stderr)

# ---------- 우리말샘 ----------
entries = {}
conj = {}
stat = Counter()
for f in sorted(glob.glob(OD + '/*.xml')):
    for ev, el in ET.iterparse(f):
        if el.tag != 'item': continue
        w = el.find('wordInfo'); s = el.find('senseInfo')
        unit = w.findtext('word_unit'); typ = s.findtext('type')
        word = w.findtext('word') or ''
        if unit not in UNITS or typ != '일반어' or not re.search('[가-힣]', word): el.clear(); continue
        k = key(word)
        sense = {'d': clean(s.findtext('definition'))}
        cat = [c.text for c in s.findall('cat_info/cat') if c.text]
        if cat: sense['c'] = cat[0]
        for r in s.findall('relation_info'):
            t = REL.get(r.findtext('type'))
            if t and r.findtext('word'): add(sense.setdefault(t, []), disp(r.findtext('word')))
        # 전문 분야 뜻은 유의어·반대말이 있거나 기본 낱말일 때만 (사전이 너무 커지지 않게)
        if cat and not (sense.get('s') or sense.get('a')) and k not in kd: stat['tech'] += 1; el.clear(); continue
        gk = (word, el.findtext('group_code'))
        e = entries.get(gk)
        if e is None:
            e = entries[gk] = {'w': disp(word), 'k': k, 'o': int(el.findtext('group_order') or 0), 'sn': []}
            if unit != '어휘': e['u'] = unit
            orig = ''.join(x.findtext('original_language') or '' for x in w.findall('original_language_info') if (x.findtext('language_type') or '') == '한자')
            if orig: e['hj'] = orig
            for c in w.findall('conju_info/conjugation_info/conjugation') + w.findall('conju_info/abbreviation_info/abbreviation'):
                if c.text: conj.setdefault(c.text.replace(' ', ''), k)
        p = s.findtext('pos')
        if p and p != '품사 없음': sense['p'] = p
        ex = [clean(x.findtext('example')) for x in s.findall('example_info')]
        ex = [x for x in ex if x and len(x) < 120][:1]
        if ex: sense['e'] = ex
        try: sense['n'] = int(s.findtext('sense_no') or 0)
        except ValueError: sense['n'] = 0
        e['sn'].append(sense)
        stat['sense'] += 1
        el.clear()
print('opendict', len(entries), stat, file=sys.stderr)

bykey = defaultdict(list)
for e in entries.values():
    e['sn'].sort(key=lambda x: x['n'])
    for x in e['sn']: x.pop('n')
    bykey[e['k']].append(e)
# 동형어 순서: 용례가 있는 것 → 전문 분야가 아닌 뜻이 있는 것 → 사전 순서 (‘사과(沙果)’가 ‘사과(참외)’보다 먼저)
def rank(e):
    return (0 if any(x.get('e') for x in e['sn']) else 1, 0 if any('c' not in x for x in e['sn']) else 1, e['o'])
for k in bykey: bykey[k].sort(key=rank)
# 낱말 단위 모음: 우리말샘 뜻별 관계 + 기초사전 + 거꾸로 이은 것
word = {}
for k, es in bykey.items():
    W = {}
    for e in es:
        for x in e['sn']:
            for t in ('s', 'a'):
                for y in x.get(t, []): add(W.setdefault(t, []), y)
    word[k] = W
for k, d in kd.items():
    if k not in bykey: continue
    W = word[k]
    for t in ('s', 'a', 'r', 'v', 'b', 'j', 'hi', 'lo'):
        for y in d.get(t, []): add(W.setdefault(t, []), y)
    if d.get('e'): W['e'] = d['e']
    if d.get('g'): W['g'] = d['g']
    for fm in d.get('f', []): conj.setdefault(fm, k)
rev = defaultdict(lambda: defaultdict(list))
for k, W in word.items():
    me = bykey[k][0]['w']
    for t in ('s', 'a'):
        for y in W.get(t, []): add(rev[key(y)][t], me)
for k, W in word.items():
    me = bykey[k][0]['w']
    for t in ('s', 'a'):
        for y in rev.get(k, {}).get(t, []):
            if y != me: add(W.setdefault(t, []), y)
        if t in W:
            have = {y for e in bykey[k] for x in e['sn'] for y in x.get(t, [])}
            W[t] = [y for y in W[t] if y not in have][:60]
            if not W[t]: del W[t]
# ---------- 뜻풀이로 잇기: 뜻풀이에 쓰인 같은 품사 낱말(‘기쁘다: …흐뭇하고 흡족하다’)과 거꾸로 그 말을 풀이에 쓴 낱말 ----------
def pos_of(k):
    for e in bykey[k]:
        for x in e['sn']:
            if x.get('p'): return x['p']
    return ''
POS = {k: pos_of(k) for k in bykey}
PRED = {'동사', '형용사'}
ENDS = [('스러운', '스럽다'), ('스럽고', '스럽다'), ('스럽게', '스럽다'), ('스럽다', '스럽다'), ('로운', '롭다'), ('롭고', '롭다'), ('롭게', '롭다'),
        ('하여', '하다'), ('하고', '하다'), ('하게', '하다'), ('하며', '하다'), ('하니', '하다'), ('하거나', '하다'), ('하지', '하다'), ('한', '하다'), ('해', '하다'), ('하다', '하다'), ('할', '하다'), ('하는', '하다'),
        ('거나', '다'), ('고', '다'), ('며', '다'), ('게', '다'), ('지', '다'), ('은', '다'), ('는', '다'), ('던', '다'), ('다', '다')]
def lem_pred(t):
    if t in conj and POS.get(conj[t]) in PRED: return conj[t]
    for a, b in ENDS:
        if t.endswith(a) and len(t) > len(a):
            c = t[:-len(a)] + b
            if POS.get(c) in PRED: return c
    return None
JOSA = ['에게서', '으로서', '으로써', '에서', '에게', '으로', '까지', '부터', '처럼', '보다', '이나', '이라', '과', '와', '을', '를', '이', '가', '은', '는', '에', '의', '로', '도', '만']
def lem_noun(t):
    if POS.get(t) == '명사': return t
    for j in JOSA:
        if t.endswith(j) and len(t) - len(j) >= 2 and POS.get(t[:-len(j)]) == '명사': return t[:-len(j)]
    return None
def toks(d):
    d = re.sub(r'\([^)]*\)', ' ', d)
    return [re.sub(r'[^가-힣]', '', t) for t in re.split(r'[\s,.·…]+', d) if re.sub(r'[^가-힣]', '', t)]
def common(c):
    if c in kd: return 0
    return 1 if any(x.get('e') for e in bykey[c] for x in e['sn']) else 2
GENERIC = set('있다 없다 하다 되다 가다 오다 나다 들다 가지다 생기다 나서다 이르다 따르다 말다 같다 듯하다 보다 지다 받다 주다 대하다 위하다 어떻다 그렇다 이렇다 저렇다 많다 적다 않다 못하다 싶다 쓰다 두다 놓다 내다 대다 삼다 여기다 이루다 일다 아니다 갖다'.split())
def cands(k, d):
    p = POS[k]; out = []
    if re.search(r'방언|옛말|잘못|북한어|준말|본말', d): return out
    T = toks(d)
    if p in PRED or p == '부사':
        for t in T:
            c = lem_pred(t) if p in PRED else (t if POS.get(t) == '부사' else None)
            if c and c != k and POS.get(c) == p and c not in GENERIC: add(out, c)
    elif p == '명사' and len(d) <= 24:
        # 이름씨는 이름씨만 늘어놓은 풀이(‘값, 가격.’, ‘거짓말.’)일 때만: ‘경계하는 마음’처럼 꾸미는 말이 붙으면 갈래(상위어) 풀이다
        parts = [re.sub(r'[^가-힣]', '', x) for x in re.split(r'[,;]', re.sub(r'\([^)]*\)', '', d))]
        if parts and all(x and POS.get(x) == '명사' for x in parts) and all(' ' not in x.strip(' .') for x in re.split(r'[,;]', d)):
            for c in parts:
                if c != k: add(out, c)
    return out
back = defaultdict(list)  # c → [(짧은 풀이?, k)]
for k, es in bykey.items():
    for e in es:
        for x in e['sn']:
            L = cands(k, x['d'])
            if not L: continue
            short = len(toks(x['d'])) <= 5
            for c in L: back[c].append((0 if short else 1, k))
            have = set(x.get('s', [])) | set(x.get('a', []))
            L = sorted(L, key=common)
            L = [bykey[c][0]['w'] for c in L if bykey[c][0]['w'] not in have][:8]
            if L: x['ds'] = L
for k in bykey:
    if k not in back: continue
    have = {y for e in bykey[k] for x in e['sn'] for y in x.get('s', []) + x.get('a', []) + x.get('ds', [])} | set(word[k].get('s', [])) | set(word[k].get('a', []))
    seen = {}
    for sh_, c in back[k]:
        seen[c] = min(seen.get(c, 9), sh_)
    L = sorted(seen, key=lambda c: (seen[c] + common(c), common(c)))
    L = [c for c in L if c != k and bykey[c][0]['w'] not in have]
    # 드물게 쓰는 말(기초 낱말도 아니고 용례도 없는 말)은 따로: 창에서 ‘더 보기’로
    d1 = [bykey[c][0]['w'] for c in L if common(c) < 2][:30]
    d2 = [bykey[c][0]['w'] for c in L if common(c) == 2][:40]
    if d1: word[k]['d'] = d1
    if d2: word[k]['d2'] = d2
# 같은 갈래 말 (기초사전 의미 갈래 + 품사)
cats = defaultdict(list)
for k, d in kd.items():
    if k in bykey and d.get('g'): cats[d['g'] + '|' + d.get('p', '')].append(bykey[k][0]['w'])
for k, W in word.items():
    d = kd.get(k)
    if d and d.get('g'): W['gk'] = d['g'] + '|' + d.get('p', '')
    if d is not None: W['k'] = 1  # 기초 낱말 (기본형 후보 고를 때 앞세운다)

os.makedirs(OUT + '/s', exist_ok=True)
def shard(k): return zlib.crc32(k.encode()) % NSH
sh = defaultdict(lambda: {'w': {}, 'c': {}})
for k, es in bykey.items():
    for e in es: e.pop('k'); e.pop('o')
    sh[shard(k)]['w'][k] = {'e': es, **({'x': word[k]} if word[k] else {})}
conj = {c: k for c, k in conj.items() if c != k and k in bykey and c not in bykey}
for c, k in conj.items(): sh[shard(c)]['c'][c] = k
for i in range(NSH):
    with open(f'{OUT}/s/{i:03d}.json', 'w', encoding='utf-8') as fp: json.dump(sh[i], fp, ensure_ascii=False, separators=(',', ':'))
with open(f'{OUT}/words.txt', 'w', encoding='utf-8') as fp: fp.write('\n'.join(sorted(bykey)))
with open(f'{OUT}/cats.json', 'w', encoding='utf-8') as fp: json.dump(cats, fp, ensure_ascii=False, separators=(',', ':'))
print('words', len(bykey), 'conj', len(conj), 'cats', len(cats), file=sys.stderr)
