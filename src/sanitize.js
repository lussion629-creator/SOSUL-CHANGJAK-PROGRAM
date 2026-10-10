// 보안: 남이 만든 백업·문서 파일에 숨은 스크립트가 실행되지 않게 한다.
// - parseHtml: HTML을 '실행되지 않는' 별도 문서에서 읽는다 (그림 onerror 같은 것이 돌지 않음)
// - sanitizeHtml: 원고에 필요 없는 태그·속성(스크립트, 이벤트, 외부 주소 등)을 지운다

export function parseHtml(html) {
  return new DOMParser().parseFromString(`<!doctype html><body>${html || ''}`, 'text/html').body;
}

// 원고에 쓰는 태그만 남긴다 (편집기 스키마와 같은 범위)
const OK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'HR', 'BR',
  'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'STRIKE', 'MARK', 'SPAN', 'DIV', 'SECTION', 'ARTICLE', 'SUB', 'SUP', 'INS']);
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'TEMPLATE',
  'NOSCRIPT', 'SVG', 'MATH', 'LINK', 'META', 'BASE', 'TITLE', 'HEAD', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT',
  'OPTION', 'IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'CANVAS', 'PORTAL', 'DIALOG']);
const OK_ATTR = /^(style|class|data-[\w-]+|start|type|colspan|rowspan)$/i;
const BAD_STYLE = /\\|url\s*\(|image-set|expression\s*\(|javascript:|behavior\s*:|-moz-binding|@import/i; // 역슬래시(CSS 이스케이프)도 막는다

export function sanitizeHtml(html) {
  if (!html) return '';
  const body = parseHtml(html);
  const walk = (el) => {
    for (const c of [...el.children]) {
      if (DROP_WITH_CONTENT.has(c.tagName)) { c.remove(); continue; }
      walk(c);
      if (!OK_TAGS.has(c.tagName)) { c.replaceWith(...c.childNodes); continue; } // 모르는 태그는 글자만 남긴다
      for (const a of [...c.attributes]) {
        if (!OK_ATTR.test(a.name) || (a.name === 'style' && BAD_STYLE.test(a.value))) c.removeAttribute(a.name);
      }
    }
  };
  walk(body);
  // 주석(조건부 주석 등)도 지운다
  const tw = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const cs = [];
  while (tw.nextNode()) cs.push(tw.currentNode);
  cs.forEach((n) => n.remove());
  return body.innerHTML;
}
