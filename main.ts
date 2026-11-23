// mend: apply an edit an AI model wrote to a tree of text files, as SPEC.md (version 1) says.
// Unified diffs (line numbers may be wrong), SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls.
// Node 22, standard library only; every file is changed or nothing is.

import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT: string = process.cwd();

type Eol = '\n' | '\r\n';

interface Doc {
  lines: string[];
  eol: Eol;
  final: boolean;
}

interface BodyEntry {
  kind: 'ctx' | 'old' | 'new' | 'slash';
  text: string;
  blank: boolean;
}

interface Change {
  status: 'A' | 'D' | 'M';
  path: string;
  text: string | null;
}

class UsageErr extends Error {}
class NoPatchErr extends Error {}
class FormatErr extends Error {}
class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super('parse');
    this.line = line;
  }
}
class EditErr extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(code);
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------- lines, files, paths

const isBlank = (s: string): boolean => s.trim() === '';
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripTrailWs = (s: string): string => s.replace(/\s+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

const eolOf = (text: string): Eol => {
  const i = text.indexOf('\n');
  return i > 0 && text.charAt(i - 1) === '\r' ? '\r\n' : '\n';
};

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], eol: '\n', final: false };
  const eol = eolOf(text);
  const parts = text.split(eol);
  let final = false;
  if (text.endsWith(eol)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, eol, final };
}

function serialize(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.eol) + (d.final ? d.eol : '');
}

function safePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) if (s === '' || s === '.' || s === '..') return false;
  return true;
}

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripTrail(stripTrail(a).replace(/^[ \t]+/, '')) === stripTrail(stripTrail(b).replace(/^[ \t]+/, ''));
}

function findOcc(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!tierEq(lines[i + k], O[k], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function oLines(body: BodyEntry[]): string[] {
  return body.filter((e) => e.kind === 'ctx' || e.kind === 'old').map((e) => e.text);
}

function nLines(body: BodyEntry[]): string[] {
  return body.filter((e) => e.kind === 'ctx' || e.kind === 'new').map((e) => e.text);
}

// The lines a matched body writes: context lines are the file's own lines; at tier 2 the other lines are
// re-indented with F for P.
function buildReplacement(body: BodyEntry[], doc: Doc, pos: number, tier: number): string[] {
  const O = oLines(body);
  const reindent = tier === 2 && O.length > 0;
  const F = reindent ? leadingWs(doc.lines[pos]) : '';
  const P = reindent ? leadingWs(O[0]) : '';
  const res: string[] = [];
  let oi = 0;
  for (const e of body) {
    if (e.kind === 'ctx') {
      res.push(doc.lines[pos + oi]);
      oi += 1;
    } else if (e.kind === 'old') {
      oi += 1;
    } else if (e.kind === 'new') {
      let t = e.text;
      if (reindent && t !== '' && !onlyWs(t) && t.startsWith(P)) t = F + t.slice(P.length);
      res.push(t);
    }
  }
  return res;
}

function reindentAll(N: string[], doc: Doc, pos: number, O: string[], tier: number): string[] {
  const reindent = tier === 2 && O.length > 0;
  const F = reindent ? leadingWs(doc.lines[pos]) : '';
  const P = reindent ? leadingWs(O[0]) : '';
  return N.map((t) => {
    let s = t;
    if (reindent && s !== '' && !onlyWs(s) && s.startsWith(P)) s = F + s.slice(P.length);
    return s;
  });
}

// ---------------------------------------------------------------- the tree

class Tree {
  now: Map<string, string>;
  gone: Set<string>;
  orig: Map<string, string | null>;
  moves: { old: string; new: string }[];

  constructor() {
    this.now = new Map<string, string>();
    this.gone = new Set<string>();
    this.orig = new Map<string, string | null>();
    this.moves = [];
  }

  diskExists(p: string): boolean {
    try {
      lstatSync(join(ROOT, p));
      return true;
    } catch {
      return false;
    }
  }

  diskRead(p: string): string | null {
    if (this.orig.has(p)) return this.orig.get(p) as string | null;
    let v: string | null = null;
    try {
      const st = lstatSync(join(ROOT, p));
      if (st.isFile()) v = readFileSync(join(ROOT, p), 'utf8');
    } catch {
      v = null;
    }
    this.orig.set(p, v);
    return v;
  }

  exists(p: string): boolean {
    if (this.now.has(p)) return true;
    if (this.gone.has(p)) return false;
    return this.diskExists(p);
  }

  read(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p) as string;
    if (this.gone.has(p)) return null;
    return this.diskRead(p);
  }

  write(p: string, text: string): void {
    this.now.set(p, text);
    this.gone.delete(p);
  }

  del(p: string): void {
    this.now.delete(p);
    this.gone.add(p);
  }

  changes(): Change[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const p of this.now.keys()) if (!seen.has(p)) { seen.add(p); paths.push(p); }
    for (const p of this.gone) if (!seen.has(p)) { seen.add(p); paths.push(p); }
    for (const p of this.orig.keys()) if (!seen.has(p)) { seen.add(p); paths.push(p); }
    const out: Change[] = [];
    for (const p of paths) {
      const before = this.diskRead(p);
      const after = this.exists(p) ? this.read(p) : null;
      if (before === null && after !== null) out.push({ status: 'A', path: p, text: after });
      else if (before !== null && after === null) out.push({ status: 'D', path: p, text: null });
      else if (before !== null && after !== null && before !== after) out.push({ status: 'M', path: p, text: after });
    }
    return out;
  }

  flush(): void {
    for (const c of this.changes()) {
      const abs = join(ROOT, c.path);
      if (c.status === 'D') {
        try { unlinkSync(abs); } catch { /* already gone */ }
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, c.text as string);
      }
    }
  }
}

// ---------------------------------------------------------------- edits

interface Edit {
  run(t: Tree): void;
}

// ---------------------------------------------------------------- unified diffs

interface Hunk {
  a: number;
  body: BodyEntry[];
}

interface Section {
  diffA?: string;
  diffB?: string;
  headerOld?: string;
  headerNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
  hasHunk: boolean;
}

const pathField = (line: string): string => {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  return s.trim();
};

const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

function parseDiffGit(line: string): { a: string; b: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const idx = rest.indexOf(' b/', 2);
  if (idx < 0) return null;
  const a = rest.slice(2, idx);
  const b = rest.slice(idx + 3);
  if (a === '' || b === '') return null;
  return { a, b };
}

function hunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return { a: parseInt(m[1], 10) };
}

function bodyOf(lines: string[], start: number): { body: BodyEntry[]; next: number } {
  const body: BodyEntry[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '', blank: true });
      j += 1;
      continue;
    }
    const c = l.charAt(0);
    if (c === ' ') body.push({ kind: 'ctx', text: l.slice(1), blank: false });
    else if (c === '-') body.push({ kind: 'old', text: l.slice(1), blank: false });
    else if (c === '+') body.push({ kind: 'new', text: l.slice(1), blank: false });
    else if (c === '\\') body.push({ kind: 'slash', text: l.slice(1), blank: false });
    else break;
    j += 1;
  }
  while (body.length > 0 && body[body.length - 1].kind === 'ctx' && body[body.length - 1].blank) body.pop();
  return { body, next: j };
}

function blankSection(): Section {
  return { newFile: false, delFile: false, hunks: [], hasHunk: false };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const g = parseDiffGit(line);
      if (g === null) throw new ParseErr(i + 1);
      cur = blankSection();
      cur.diffA = g.a;
      cur.diffB = g.b;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && !cur.hasHunk) {
        cur.headerOld = pathField(line);
        cur.headerNew = pathField(lines[i + 1]);
      } else {
        cur = blankSection();
        cur.headerOld = pathField(line);
        cur.headerNew = pathField(lines[i + 1]);
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseErr(i + 1);
      const h = hunkHeader(line);
      if (h === null) throw new ParseErr(i + 1);
      const got = bodyOf(lines, i + 1);
      cur.hunks.push({ a: h.a, body: got.body });
      cur.hasHunk = true;
      i = got.next;
      continue;
    }
    if (cur !== null && !cur.hasHunk) {
      if (line.startsWith('--- ')) throw new ParseErr(i + 2);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

function slashAfterLastN(body: BodyEntry[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) if (body[i].kind === 'ctx' || body[i].kind === 'new') last = i;
  return last >= 0 && last + 1 < body.length && body[last + 1].kind === 'slash';
}

interface Resolved {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
}

function resolveSection(s: Section): Resolved {
  const hOld = s.headerOld;
  const hNew = s.headerNew;
  const create = hOld === '/dev/null' || s.newFile;
  const del = hNew === '/dev/null' || s.delFile;
  let oldRaw: string | undefined = hOld !== undefined ? hOld : s.renameFrom !== undefined ? s.renameFrom : s.diffA;
  let newRaw: string | undefined = hNew !== undefined ? hNew : s.renameTo !== undefined ? s.renameTo : s.diffB;
  const oldPath = oldRaw === undefined || oldRaw === '/dev/null' ? null : stripPrefix(oldRaw);
  const newPath = newRaw === undefined || newRaw === '/dev/null' ? null : stripPrefix(newRaw);
  return { oldPath, newPath, create, del };
}

function applyHunk(doc: Doc, h: Hunk, d: number, strict: boolean, path: string): void {
  const body = h.body;
  const O = oLines(body);
  const N = nLines(body);
  const maxTier = strict ? 0 : 2;
  let pos = -1;
  let tier = 0;
  if (O.length === 0) {
    pos = Math.min(Math.max(h.a + d, 0), doc.lines.length);
    const repl = N.slice();
    const atEnd = pos === doc.lines.length;
    doc.lines.splice(pos, 0, ...repl);
    if (atEnd) doc.final = !slashAfterLastN(body);
    return;
  }
  for (tier = 0; tier <= maxTier; tier++) {
    const occ = findOcc(doc.lines, O, tier, 0);
    if (occ.length === 0) continue;
    const target = h.a - 1 + d;
    pos = occ[0];
    let best = Math.abs(pos - target);
    for (const p of occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    break;
  }
  if (pos < 0) throw new EditErr('no-match', path);
  const repl = buildReplacement(body, doc, pos, tier);
  const atEnd = pos + O.length === doc.lines.length;
  doc.lines.splice(pos, O.length, ...repl);
  if (atEnd) doc.final = !slashAfterLastN(body);
}

function unifiedEdits(sections: Section[], strict: boolean): Edit[] {
  return sections.map((s) => ({
    run(t: Tree): void {
      const r = resolveSection(s);
      if (r.create) {
        const p = r.newPath === null ? '' : r.newPath;
        if (!safePath(p)) throw new EditErr('unsafe', p);
        if (t.exists(p)) throw new EditErr('exists', p);
        const out: string[] = [];
        let lastHunk = -1;
        let lastIdx = -1;
        for (let hi = 0; hi < s.hunks.length; hi++) {
          const b = s.hunks[hi].body;
          for (let bi = 0; bi < b.length; bi++) {
            if (b[bi].kind === 'new') {
              out.push(b[bi].text);
              lastHunk = hi;
              lastIdx = bi;
            }
          }
        }
        let final = true;
        if (lastHunk >= 0) {
          const b = s.hunks[lastHunk].body;
          if (lastIdx + 1 < b.length && b[lastIdx + 1].kind === 'slash') final = false;
        }
        t.write(p, out.length === 0 ? '' : out.join('\n') + (final ? '\n' : ''));
        return;
      }
      if (r.del) {
        const p = r.oldPath === null ? '' : r.oldPath;
        if (!safePath(p)) throw new EditErr('unsafe', p);
        if (!t.exists(p)) throw new EditErr('missing', p);
        t.del(p);
        return;
      }
      const oldPath = r.oldPath === null ? '' : r.oldPath;
      if (!safePath(oldPath)) throw new EditErr('unsafe', oldPath);
      const move = r.newPath !== null && r.newPath !== r.oldPath;
      if (move) {
        const np = r.newPath as string;
        if (!safePath(np)) throw new EditErr('unsafe', np);
      }
      const text = t.read(oldPath);
      if (text === null) throw new EditErr('missing', oldPath);
      if (move && t.exists(r.newPath as string)) throw new EditErr('exists', r.newPath as string);
      const doc = parseDoc(text);
      let d = 0;
      for (const h of s.hunks) {
        applyHunk(doc, h, d, strict, oldPath);
        d += nLines(h.body).length - oLines(h.body).length;
      }
      const out = serialize(doc);
      if (move) {
        const np = r.newPath as string;
        t.write(np, out);
        t.del(oldPath);
        t.moves.push({ old: oldPath, new: np });
      } else {
        t.write(oldPath, out);
      }
    },
  }));
}

// ---------------------------------------------------------------- SEARCH/REPLACE

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_DIV = '=======';
const SR_END = '>>>>>>> REPLACE';

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return {
    run(t: Tree): void {
      if (!safePath(path)) throw new EditErr('unsafe', path);
      if (oldLines.length === 0) {
        if (t.exists(path)) throw new EditErr('exists', path);
        t.write(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const text = t.read(path);
      if (text === null) throw new EditErr('missing', path);
      const doc = parseDoc(text);
      const maxTier = strict ? 0 : 2;
      let tier = -1;
      let occ: number[] = [];
      for (let k = 0; k <= maxTier; k++) {
        occ = findOcc(doc.lines, oldLines, k, 0);
        if (occ.length > 0) {
          tier = k;
          break;
        }
      }
      if (tier < 0) throw new EditErr('no-match', path);
      if (occ.length > 1) throw new EditErr('ambiguous', path);
      const pos = occ[0];
      const repl = reindentAll(newLines, doc, pos, oldLines, tier);
      doc.lines.splice(pos, oldLines.length, ...repl);
      t.write(path, serialize(doc));
    },
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let lastEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (stripTrailWs(lines[i]) !== SR_SEARCH) {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j > lastEnd; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      const tr = l.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseErr(searchLine + 1);
    let div = -1;
    for (let j = i + 1; j < n; j++) {
      const s = stripTrailWs(lines[j]);
      if (s === SR_DIV) {
        div = j;
        break;
      }
      if (s === SR_END) break;
    }
    if (div < 0) throw new ParseErr(searchLine + 1);
    let end = -1;
    for (let j = div + 1; j < n; j++) {
      if (stripTrailWs(lines[j]) === SR_END) {
        end = j;
        break;
      }
    }
    if (end < 0) throw new ParseErr(searchLine + 1);
    const oldLines = lines.slice(i + 1, div);
    const newLines = lines.slice(div + 1, end);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    lastEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: Chunk[];
  line: number;
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

const isSectionStart = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (last <= first || lines[last].trim() !== '*** End Patch') throw new ParseErr(n + 1);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(V_ADD)) {
      const path = line.slice(V_ADD.length).trim();
      i += 1;
      const start = i;
      const raw: string[] = [];
      while (i < last && !isSectionStart(lines[i])) {
        raw.push(lines[i]);
        i += 1;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1])) raw.pop();
      const content: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k];
        if (l === '') content.push('');
        else if (l.startsWith('+')) content.push(l.slice(1));
        else throw new ParseErr(start + k + 1);
      }
      sections.push({ kind: 'add', path, moveTo: null, addLines: content, chunks: [], line: -1 });
      continue;
    }
    if (line.startsWith(V_DEL)) {
      const path = line.slice(V_DEL.length).trim();
      i += 1;
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l)) break;
        if (!isBlank(l)) throw new ParseErr(i + 1);
        i += 1;
      }
      sections.push({ kind: 'del', path, moveTo: null, addLines: [], chunks: [], line: -1 });
      continue;
    }
    if (line.startsWith(V_UPD)) {
      const path = line.slice(V_UPD.length).trim();
      const updLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith(V_MOVE)) {
        moveTo = lines[i].slice(V_MOVE.length).trim();
        i += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new ParseErr(i + 1);
          cur.eof = true;
          i += 1;
          continue;
        }
        if (l === '') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({ kind: 'ctx', text: '', blank: true });
          i += 1;
          continue;
        }
        const c = l.charAt(0);
        if (c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: l.slice(1), blank: onlyWs(l) });
          i += 1;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1].kind === 'ctx' && lastChunk.body[lastChunk.body.length - 1].blank) lastChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(updLine);
      sections.push({ kind: 'upd', path, moveTo, addLines: [], chunks, line: updLine });
      continue;
    }
    throw new ParseErr(i + 1);
  }
  return sections.map((s) => ({ run: (t: Tree): void => runVSection(t, s, strict) }));
}

function runVSection(t: Tree, s: VSection, strict: boolean): void {
  if (s.kind === 'add') {
    if (!safePath(s.path)) throw new EditErr('unsafe', s.path);
    if (t.exists(s.path)) throw new EditErr('exists', s.path);
    t.write(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    return;
  }
  if (s.kind === 'del') {
    if (!safePath(s.path)) throw new EditErr('unsafe', s.path);
    if (!t.exists(s.path)) throw new EditErr('missing', s.path);
    t.del(s.path);
    return;
  }
  if (!safePath(s.path)) throw new EditErr('unsafe', s.path);
  if (s.moveTo !== null && !safePath(s.moveTo)) throw new EditErr('unsafe', s.moveTo);
  const text = t.read(s.path);
  if (text === null) throw new EditErr('missing', s.path);
  if (s.moveTo !== null && t.exists(s.moveTo)) throw new EditErr('exists', s.moveTo);
  const doc = parseDoc(text);
  const maxTier = strict ? 0 : 2;
  let cursor = 0;
  for (const ch of s.chunks) {
    if (ch.anchor !== null) {
      let found = -1;
      for (let tier = 0; tier <= maxTier && found < 0; tier++) {
        for (let p = cursor; p < doc.lines.length; p++) {
          if (tierEq(doc.lines[p], ch.anchor, tier)) {
            found = p;
            break;
          }
        }
      }
      if (found < 0) throw new EditErr('no-match', s.path);
      cursor = found + 1;
    }
    const O = oLines(ch.body);
    if (O.length === 0) {
      const N = nLines(ch.body);
      const pos = ch.eof ? doc.lines.length : Math.min(cursor, doc.lines.length);
      doc.lines.splice(pos, 0, ...N);
      cursor = pos + N.length;
      continue;
    }
    let pos = -1;
    let tier = 0;
    for (tier = 0; tier <= maxTier; tier++) {
      for (let p = cursor; p + O.length <= doc.lines.length; p++) {
        if (ch.eof && p + O.length !== doc.lines.length) continue;
        let ok = true;
        for (let k = 0; k < O.length; k++) {
          if (!tierEq(doc.lines[p + k], O[k], tier)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          pos = p;
          break;
        }
      }
      if (pos >= 0) break;
    }
    if (pos < 0) throw new EditErr('no-match', s.path);
    const repl = buildReplacement(ch.body, doc, pos, tier);
    doc.lines.splice(pos, O.length, ...repl);
    cursor = pos + repl.length;
  }
  const out = serialize(doc);
  if (s.moveTo !== null) {
    t.write(s.moveTo, out);
    t.del(s.path);
    t.moves.push({ old: s.path, new: s.moveTo });
  } else {
    t.write(s.path, out);
  }
}

// ---------------------------------------------------------------- JSON

function jsonEdit(o: unknown): Edit | null {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.path !== 'string') return null;
  const path = r.path;
  if (r.command === 'create') {
    if (typeof r.file_text !== 'string') return null;
    const text = r.file_text;
    return {
      run(t: Tree): void {
        if (!safePath(path)) throw new EditErr('unsafe', path);
        if (t.exists(path)) throw new EditErr('exists', path);
        t.write(path, text);
      },
    };
  }
  if (r.command === 'str_replace') {
    if (typeof r.old_str !== 'string' || r.old_str === '') return null;
    if (r.new_str !== undefined && typeof r.new_str !== 'string') return null;
    const oldStr = r.old_str;
    const newStr = r.new_str === undefined ? '' : (r.new_str as string);
    return {
      run(t: Tree): void {
        if (!safePath(path)) throw new EditErr('unsafe', path);
        const text = t.read(path);
        if (text === null) throw new EditErr('missing', path);
        const crlf = eolOf(text) === '\r\n';
        const body = crlf ? text.split('\r\n').join('\n') : text;
        const o2 = crlf ? oldStr.split('\r\n').join('\n') : oldStr;
        const n2 = crlf ? newStr.split('\r\n').join('\n') : newStr;
        let count = 0;
        let at = -1;
        let from = 0;
        for (;;) {
          const j = body.indexOf(o2, from);
          if (j < 0) break;
          count += 1;
          if (at < 0) at = j;
          from = j + 1;
        }
        if (count === 0) throw new EditErr('no-match', path);
        if (count > 1) throw new EditErr('ambiguous', path);
        let res = body.slice(0, at) + n2 + body.slice(at + o2.length);
        if (crlf) res = res.split('\n').join('\r\n');
        t.write(path, res);
      },
    };
  }
  if (r.command === 'insert') {
    if (typeof r.insert_line !== 'number' || !Number.isInteger(r.insert_line)) return null;
    if (typeof r.new_str !== 'string') return null;
    const line = r.insert_line;
    const newStr = r.new_str;
    return {
      run(t: Tree): void {
        if (!safePath(path)) throw new EditErr('unsafe', path);
        const text = t.read(path);
        if (text === null) throw new EditErr('missing', path);
        const doc = parseDoc(text);
        if (line < 0 || line > doc.lines.length) throw new EditErr('no-match', path);
        const add: string[] = [];
        if (newStr !== '') {
          const parts = newStr.split('\n');
          if (newStr.endsWith('\n')) parts.pop();
          for (const p of parts) add.push(p.endsWith('\r') ? p.slice(0, -1) : p);
        }
        doc.lines.splice(line, 0, ...add);
        t.write(path, serialize(doc));
      },
    };
  }
  return null;
}

function parseJson(text: string, lines: string[], strict: boolean): Edit[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('[')) {
    let start = 1;
    for (let i = 0; i < lines.length; i++) {
      if (!isBlank(lines[i])) {
        start = i + 1;
        break;
      }
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ParseErr(start);
    }
    if (!Array.isArray(data)) throw new ParseErr(start);
    const edits: Edit[] = [];
    for (const item of data) {
      const e = jsonEdit(item);
      if (e === null) throw new ParseErr(start);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let data: unknown;
    try {
      data = JSON.parse(lines[i]);
    } catch {
      throw new ParseErr(i + 1);
    }
    const e = jsonEdit(data);
    if (e === null) throw new ParseErr(i + 1);
    edits.push(e);
  }
  return edits;
}

// ---------------------------------------------------------------- detection

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first >= 0) {
    if (lines[first].trim() === '*** Begin Patch') return 'v4a';
    const c = lines[first].trimStart().charAt(0);
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) if (stripTrailWs(l) === SR_SEARCH) return 'search-replace';
  for (const l of lines) if (l.startsWith('diff --git ')) return 'unified';
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].startsWith('--- ') && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- invocation

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Options {
  let format = 'auto';
  let check = false;
  let strict = false;
  let sawCheck = false;
  let sawStrict = false;
  let sawFormat = false;
  let afterDD = false;
  const positional: string[] = [];
  const names = ['unified', 'search-replace', 'v4a', 'json', 'auto'];
  for (const a of argv) {
    if (!afterDD && a === '--') {
      afterDD = true;
      continue;
    }
    if (afterDD || a === '-') {
      positional.push(a);
      continue;
    }
    if (a.startsWith('-')) {
      if (a === '--check') {
        if (sawCheck) throw new UsageErr();
        sawCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (sawStrict) throw new UsageErr();
        sawStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (sawFormat) throw new UsageErr();
        sawFormat = true;
        const v = a.slice('--format='.length);
        if (!names.includes(v)) throw new UsageErr();
        format = v;
      } else {
        throw new UsageErr();
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) throw new UsageErr();
  const patch = positional.length === 1 ? positional[0] : null;
  return { format, check, strict, patch };
}

function patchText(patch: string | null): string {
  if (patch === null || patch === '-') {
    return readFileSync(0, 'utf8');
  }
  try {
    return readFileSync(join(ROOT, patch), 'utf8');
  } catch {
    throw new NoPatchErr();
  }
}

function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function execute(): number {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch {
    process.stdout.write('error: usage\n');
    return 2;
  }
  let text: string;
  try {
    text = patchText(opts.patch);
  } catch {
    process.stdout.write('error: no-patch\n');
    return 2;
  }
  const lines = patchLines(text);
  let format = opts.format;
  if (format === 'auto') {
    const got = detectFormat(lines);
    if (got === null) {
      process.stdout.write('error: format\n');
      return 2;
    }
    format = got;
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = unifiedEdits(parseUnified(lines), opts.strict);
    else if (format === 'search-replace') edits = parseSearchReplace(lines, opts.strict);
    else if (format === 'v4a') edits = parseV4A(lines, opts.strict);
    else edits = parseJson(text, lines, opts.strict);
    if (edits.length === 0) throw new ParseErr(1);
  } catch (err) {
    if (err instanceof ParseErr) {
      process.stdout.write(`error: parse ${err.line}\n`);
      return 2;
    }
    throw err;
  }
  const tree = new Tree();
  const failures: string[] = [];
  for (const e of edits) {
    try {
      e.run(tree);
    } catch (err) {
      if (err instanceof EditErr) failures.push(`error: ${err.code} ${err.path}`);
      else throw err;
    }
  }
  if (failures.length > 0) {
    const out = failures.join('\n') + '\n' + `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    return 1;
  }
  const changes = tree.changes();
  const byPath = new Map<string, Change>();
  for (const c of changes) byPath.set(c.path, c);
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const m of tree.moves) {
    const o = byPath.get(m.old);
    const nw = byPath.get(m.new);
    if (o !== undefined && nw !== undefined && o.status === 'D' && nw.status === 'A' && !consumed.has(m.old) && !consumed.has(m.new)) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      consumed.add(m.old);
      consumed.add(m.new);
    }
  }
  for (const c of changes) {
    if (consumed.has(c.path)) continue;
    rows.push({ key: c.path, line: `${c.status} ${c.path}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  const k = rows.length;
  let out = '';
  for (const r of rows) out += r.line + '\n';
  out += `ok: ${k} ${k === 1 ? 'file' : 'files'}\n`;
  if (!opts.check) tree.flush();
  process.stdout.write(out);
  return 0;
}

const envUrl: string | undefined = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const mod = await import('./runner.ts');
  await mod.runTrial(envUrl);
  process.exitCode = 0;
} else {
  process.exitCode = execute();
}
