// 원고를 A4 쪽 단위로 나눠 PDF처럼 보여 준다
export function paginate(html, target, { header = '' } = {}) {
  target.innerHTML = '';
  target.classList.add('pages');
  const src = document.createElement('div');
  src.innerHTML = html;
  const blocks = [...src.children];
  let n = 0;
  let page, body;
  const newPage = () => {
    page = document.createElement('div');
    page.className = 'page';
    body = document.createElement('div');
    body.className = 'page-body prose';
    const foot = document.createElement('div');
    foot.className = 'page-foot';
    foot.textContent = String(++n);
    if (header) {
      const h = document.createElement('div');
      h.className = 'page-head';
      h.textContent = header;
      page.appendChild(h);
    }
    page.append(body, foot);
    target.appendChild(page);
  };
  const fits = () => body.scrollHeight <= body.clientHeight + 1;
  newPage();
  if (!blocks.length) return n;
  for (let b of blocks) {
    body.appendChild(b);
    if (fits()) continue;
    // 넘치면: 이 블록을 다음 쪽으로 넘기거나, 블록 자체가 길면 글자 단위로 쪼갠다
    body.removeChild(b);
    let guard = 0;
    while (b && guard++ < 500) {
      body.appendChild(b);
      if (fits()) { b = null; break; }
      body.removeChild(b);
      const len = b.textContent.length;
      let lo = 0, hi = len;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const [first] = splitAt(b, mid);
        body.appendChild(first);
        const ok = fits();
        body.removeChild(first);
        if (ok) lo = mid; else hi = mid - 1;
      }
      if (lo === 0) {
        if (!body.children.length) { body.appendChild(b); b = null; break; } // 한 쪽에도 안 들어가는 블록
        newPage();
        continue;
      }
      const [first, rest] = splitAt(b, lo);
      body.appendChild(first);
      newPage();
      b = rest;
    }
  }
  return n;
}

// 요소를 글자 위치 n에서 둘로 나눈다(안의 서식 태그는 유지)
function splitAt(el, n) {
  const a = el.cloneNode(true);
  const b = el.cloneNode(true);
  cut(a, n, true);
  cut(b, n, false);
  b.classList.add('cont');
  return [a, b];
}
function cut(root, n, keepHead) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  const texts = [];
  while (w.nextNode()) texts.push(w.currentNode);
  for (const t of texts) {
    const len = t.textContent.length;
    if (keepHead) {
      if (pos >= n) t.textContent = '';
      else if (pos + len > n) t.textContent = t.textContent.slice(0, n - pos);
    } else {
      if (pos + len <= n) t.textContent = '';
      else if (pos < n) t.textContent = t.textContent.slice(n - pos);
    }
    pos += len;
  }
}
