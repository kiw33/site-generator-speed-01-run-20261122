// A faster drop-in for makefun-site 1.0.0.
//
// Written from the makefun-site README (its front matter, template dialect,
// Markdown subset, slug rule and report) and checked against the reference's
// behaviour on the practice set. Same answers, different machinery:
//   - one line split per source, shared by front matter and Markdown;
//   - Markdown rendered in a single streaming pass, no token array;
//   - inline rendering that jumps between special characters and escapes
//     plain runs in bulk;
//   - slugs memoised per case, with an ASCII fast path;
//   - templates compiled once per case into small render functions;
//   - word counts scanned without allocating a match array.
// Per-case slug memo, reset at the start of every run: nothing is carried
// from one case to the next.
let slugCache = new Map();
let pathCache = new Map();

// ---- text helpers -------------------------------------------------------

const ESC_RE = /[&<>"']/;
const ESC_G = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return ESC_RE.test(s) ? s.replace(ESC_G, (c) => ESC_MAP[c]) : s;
}

// JS \s, exactly: the ASCII six plus the Unicode spaces.
function isWS(code) {
  return (
    code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

function slugOf(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function wordsOfLines(lines, from) {
  let n = 0;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    let inWord = false;
    for (let k = 0; k < line.length; k++) {
      const code = line.charCodeAt(k);
      if (
        code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
        code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
        code === 0x3000 || code === 0xfeff
      ) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

// ---- front matter -------------------------------------------------------

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyChar(code) {
  return (code >= 97 && code <= 122) || code === 95;
}

// A quoted or bare string value; returns {value} or {error}.
function stringVal(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function keyVal(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringVal(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

// Parses front matter over the source's lines; returns {data, bodyFrom} or {error}.
function parseFM(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length && isKeyChar(line.charCodeAt(k))) k++;
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let end = raw.length;
    while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end--;
    raw = raw.slice(0, end);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = keyVal(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyFrom: close + 1 };
}

// ---- Markdown -----------------------------------------------------------

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const SPECIAL_RE = /[\\`*[]/g;

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(code) {
  return (
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
    code === 95 || code === 43 || code === 45
  );
}

// Fence open: line of ``` + optional language, then spaces/tabs only. Returns lang or null.
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A heading line's {depth, text}, or null (text never empty).
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let i = n;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let end = line.length;
  while (end > i && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === i) return null;
  return { depth: n, text: line.slice(i, end) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const dash = line.charCodeAt(0) === 45;
  const star = line.charCodeAt(0) === 42;
  if (!dash && !star) return false;
  const ch = dash ? 45 : 42;
  if (line.charCodeAt(1) !== ch || line.charCodeAt(2) !== ch) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsPara(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  return null;
}

function orderedOf(line) {
  let i = 0;
  while (i < 9 && i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isWS(line.charCodeAt(i));
}

// The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
// A position is escaped exactly when an odd run of backslashes stands right before it.
function findUnesc(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    let b = 0;
    for (let p = k - 1; p >= from && s.charCodeAt(p) === 92; p--) b++;
    if (b % 2 === 0) return k;
    j = k + 1;
  }
}

// The first single * from `from` (one whose run is not **), outside an escape, or -1.
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    let b = 0;
    for (let p = k - 1; p >= from && s.charCodeAt(p) === 92; p--) b++;
    if (b % 2 === 1) {
      j = k + 1;
      continue;
    }
    if (s.charCodeAt(k + 1) === 42) {
      j = k + 2;
      continue;
    }
    return k;
  }
}

function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

// `s` rendered inline; env.link(target) resolves a link's href.
function inline(s, env) {
  const n = s.length;
  const out = [];
  let i = 0;
  let start = 0;
  while (i < n) {
    SPECIAL_RE.lastIndex = i;
    const mt = SPECIAL_RE.exec(s);
    if (mt === null) break;
    const j = mt.index;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (j > start) out.push(esc(s.slice(start, j)));
        out.push(s[j + 1]);
        i = j + 2;
        start = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > start) out.push(esc(s.slice(start, j)));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        start = i;
      } else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnesc(s, '**', j + 2);
        if (k > j + 2) {
          if (j > start) out.push(esc(s.slice(start, j)));
          out.push('<strong>', inline(s.slice(j + 2, k), env), '</strong>');
          i = k + 2;
          start = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > start) out.push(esc(s.slice(start, j)));
        out.push('<em>', inline(s.slice(j + 1, k), env), '</em>');
        i = k + 1;
        start = i;
      } else i = j + 1;
      continue;
    }
    // '['
    const k = findUnesc(s, ']', j + 1);
    let m = -1;
    if (k !== -1 && s.charCodeAt(k + 1) === 40) m = s.indexOf(')', k + 2);
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWS(target)) {
      if (j > start) out.push(esc(s.slice(start, j)));
      out.push('<a href="', esc(env.link(target)), '">', inline(s.slice(j + 1, k), env), '</a>');
      i = m + 1;
      start = i;
    } else i = j + 1;
  }
  if (start < n) out.push(esc(s.slice(start)));
  return out.join('');
}

// `lines[from..]` rendered: {html, toc, excerpt}.
function renderMd(lines, from, env) {
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  const n = lines.length;
  let i = from;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let code = '';
      for (const l of body) code += `${esc(l)}\n`;
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${code}</code></pre>`);
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugOf(h.text), ids);
      const inner = inline(h.text, env);
      blocks.push(`<h${h.depth} id="${id}">${inner}</h${h.depth}>`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: inner });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const first = bulletOf(line) ?? orderedOf(line);
    if (first !== null) {
      const ordered = first.ordered;
      const items = [];
      while (i < n) {
        const m = ordered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && first.start !== 1 ? `<ol start="${first.start}">` : `<${tag}>`;
      let list = `${open}\n`;
      for (const parts of items) list += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${list}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---- Templates ----------------------------------------------------------

class TplErr extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathParts(name, text) {
  if (!PATH_RE.test(text)) throw new TplErr(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Tokens: {t:'text', text} | {t:'var'|'raw', path} | {t:'tag', tag}. A {% %} tag
// alone on its line takes the whole line with it, newline included.
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TplErr(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplErr(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let p = lineStart; p < open; p++) {
      const c = src.charCodeAt(p);
      if (c !== 32 && c !== 9) {
        standalone = false;
        break;
      }
    }
    if (standalone) {
      for (let p = end; p < lineEnd; p++) {
        const c = src.charCodeAt(p);
        if (c !== 32 && c !== 9) {
          standalone = false;
          break;
        }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Tokens parsed into a tree of nodes. Node shapes:
// ['text', s] ['var', path] ['raw', path]
// ['for', name, path, body] ['if', not, path, then, else|null] ['include', name]
function parseTpl(name, src) {
  const root = [];
  const stack = [{ kind: 'root', body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push(['text', tok.text]);
    else if (tok.t === 'var' || tok.t === 'raw') body.push([tok.t, tok.path]);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = ['for', m[1], pathParts(name, m[2]), []];
        body.push(node);
        stack.push({ kind: 'for', body: node[3] });
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = ['if', m[1] !== undefined, pathParts(name, m[2]), [], null];
        body.push(node);
        stack.push({ kind: 'if', node, body: node[3] });
        body = node[3];
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.node[4] !== null) throw new TplErr(`template "${name}": an else outside an if`);
        top.node[4] = [];
        top.body = top.node[4];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TplErr(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.body;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push(['include', m[1]]);
      else throw new TplErr(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TplErr(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

// The value at `path` in the scope chain: first name from the nearest scope
// holding it, then own properties of the value so far.
function lk(s, path) {
  let cur = s;
  const first = path[0];
  while (cur !== null && !Object.hasOwn(cur.v, first)) cur = cur.p;
  if (cur === null) return undefined;
  let v = cur.v[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

// A value as text: string itself, number in JS digits, true/false, an array's
// items joined by ", ", anything else "".
function tx(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tx).join(', ');
  return '';
}

function tr(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Compile a parsed template into a render function (S, O, D): S a scope
// {v, p}, O the output string array, D the include depth. X carries the
// helpers and the compiled templates (read at render time).
function compileTpl(name, src, X) {
  const nodes = parseTpl(name, src);
  const paths = [];
  const pathIdx = new Map();
  const collect = (ns) => {
    for (const nd of ns) {
      if (nd[0] === 'var' || nd[0] === 'raw') {
        const key = nd[1].join('.');
        if (!pathIdx.has(key)) {
          pathIdx.set(key, paths.length);
          paths.push(nd[1]);
        }
      } else if (nd[0] === 'for') {
        const key = nd[2].join('.');
        if (!pathIdx.has(key)) {
          pathIdx.set(key, paths.length);
          paths.push(nd[2]);
        }
        collect(nd[3]);
      } else if (nd[0] === 'if') {
        const key = nd[2].join('.');
        if (!pathIdx.has(key)) {
          pathIdx.set(key, paths.length);
          paths.push(nd[2]);
        }
        collect(nd[3]);
        if (nd[4] !== null) collect(nd[4]);
      }
    }
  };
  collect(nodes);
  let tmp = 0;
  const emit = (ns, s, out) => {
    for (const nd of ns) {
      const kind = nd[0];
      if (kind === 'text') {
        out.push(`O.push(${JSON.stringify(nd[1])});`);
      } else if (kind === 'var') {
        out.push(`O.push(X.esc(X.tx(X.lk(${s},P[${pathIdx.get(nd[1].join('.'))}]))));`);
      } else if (kind === 'raw') {
        out.push(`O.push(X.tx(X.lk(${s},P[${pathIdx.get(nd[1].join('.'))}])));`);
      } else if (kind === 'if') {
        const cond = `X.tr(X.lk(${s},P[${pathIdx.get(nd[2].join('.'))}]))`;
        out.push(nd[1] ? `if(!${cond}){` : `if(${cond}){`);
        emit(nd[3], s, out);
        if (nd[4] !== null) {
          out.push('}else{');
          emit(nd[4], s, out);
        }
        out.push('}');
      } else if (kind === 'for') {
        const x = `_x${tmp}`;
        const l = `_l${tmp}`;
        const sv = `_s${tmp}`;
        const k = `_k${tmp}`;
        tmp++;
        out.push(`{const ${x}=X.lk(${s},P[${pathIdx.get(nd[2].join('.'))}]);if(Array.isArray(${x})){const ${l}={index:0,first:true,last:false,length:${x}.length};const ${sv}={v:{},p:${s}};for(let ${k}=0;${k}<${x}.length;${k}++){${l}.index=${k}+1;${l}.first=${k}===0;${l}.last=${k}===${x}.length-1;${sv}.v[${JSON.stringify(nd[1])}]=${x}[${k}];${sv}.v.loop=${l};`);
        emit(nd[3], sv, out);
        out.push('}}}');
      } else if (kind === 'include') {
        out.push(`if(D<8){const _f=X.f[${JSON.stringify(nd[1])}];if(_f!==undefined)_f(${s},O,D+1);}`);
      }
    }
  };
  const srcOut = [];
  emit(nodes, 'S', srcOut);
  return new Function('X', `const P=${JSON.stringify(paths)};return function(S,O,D){${srcOut.join('')}}`)(X);
}

// ---- the build ----------------------------------------------------------

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const RESERVED = ['posts', 'tags', 'page'];

function resolvePath(dir, rel) {
  const key = `${dir}\0${rel}`;
  if (pathCache.has(key)) return pathCache.get(key);
  const parts = dir === '' ? [] : dir.split('/');
  let out = null;
  let ok = true;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) {
        ok = false;
        break;
      }
      parts.pop();
    } else parts.push(seg);
  }
  if (ok) out = parts.join('/');
  pathCache.set(key, out);
  return out;
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function run(input) {
  // Fresh per-case state: nothing is carried from one case to the next.
  slugCache = new Map();
  pathCache = new Map();
  const report = [];
  const broken = new Set();
  const base = input.site.base_url.replace(/\/+$/, '');

  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out.
  const F = {};
  const X = { f: F, lk, tx, tr, esc };
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      F[name] = compileTpl(name, input.templates[name], X);
    } catch (err) {
      if (!(err instanceof TplErr)) throw err;
      report.push(err.message);
    }
  }

  const render = (name, vars) => {
    const fn = F[name];
    if (fn === undefined) return null;
    const O = [];
    fn({ v: vars, p: null }, O, 0);
    return O.join('');
  };

  // Sources, in code-unit order of path; line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      const lines = text.split('\n');
      sources.push({ path: f.path, lines });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in order: refused, the generator's own directories,
  // a post with no date, a layout no template has, then a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyFrom = fm.bodyFrom;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (F[layout] === undefined) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, links resolved to pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      },
    };
    const md = renderMd(s.lines, s.bodyFrom, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags, grouped by slug, each named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugOf(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages and the layouts.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.lines, s.bodyFrom) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  for (const p of posts) p.card = cards.get(p);
  const pageOf = (s) => {
    let card = s.card;
    if (card === undefined) {
      card = cardOf(s);
      s.card = card;
    }
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const baseVars = { site, tags: allTags, recent };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { ...baseVars, page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      ...baseVars,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      ...baseVars,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', baseVars);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const nPages = kept.filter((s) => !s.post).length;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
