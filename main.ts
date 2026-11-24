// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, as [old, new] pairs, in the order the edits made them. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3)
// ---------------------------------------------------------------------------

interface FileState {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBr ? f.br : '');
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC.md section 5)
// ---------------------------------------------------------------------------

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

/** 0-based positions where O occurs in `lines` at `tier`, starting at `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0, endAtLastLine = false): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    if (endAtLastLine && i + o.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!tierEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (from `from`), with its positions. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
  endAtLastLine = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from, endAtLastLine);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (tierEq(lines[i]!, anchor, t)) return { tier: t, pos: i };
    }
  }
  return null;
}

/** One line of N: `ctx >= 0` is a context line, the ctx-th line of O; -1 is a new line. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * N written over the match at `pos`: context lines are the file's own matched lines; at tier 2
 * every other line is re-indented from O's first line's leading whitespace to the file's.
 */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const f = leadingST(fileLines[pos] ?? '');
  const p = leadingST(o[0] ?? '');
  return n.map((nl) => {
    if (nl.ctx >= 0) return fileLines[pos + nl.ctx]!;
    if (tier === 2 && nl.text !== '' && !/^[ \t]+$/.test(nl.text) && nl.text.startsWith(p)) return f + nl.text.slice(p.length);
    return nl.text;
  });
}

/** A body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

/** O is the context and `-` lines, N the context and `+` lines, each in body order. */
function splitBody(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      n.push({ text: b.text, ctx: o.length });
      o.push(b.text);
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the body's last line of one of `kinds` (its `\ No newline` mark). */
function noNewlineAfterLast(body: BodyLine[], kinds: Array<' ' | '+'>): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (kinds.includes(body[i]!.kind as ' ' | '+')) last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newUniSection(): UniSection {
  return {
    pairOld: null,
    pairNew: null,
    hasPair: false,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

/** The path after `--- ` or `+++ `: up to the first tab, trimmed, `a/`/`b/` stripped, `/dev/null` none. */
function diffPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newUniSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.pairOld = diffPath(line.slice(4));
        cur.pairNew = diffPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
      } else {
        cur = newUniSection();
        cur.pairOld = diffPath(line.slice(4));
        cur.pairNew = diffPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          hunk.body.push({ kind: ' ', text: '' });
          i += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          hunk.body.push({ kind: c, text: bl.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0) {
        const lastB = hunk.body[hunk.body.length - 1]!;
        if (lastB.kind === ' ' && lastB.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      else if (line.startsWith('+++ ') && cur.pairNew === null) cur.pairNew = diffPath(line.slice(4));
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.body);
    if (o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const wasEnd = at === f.lines.length;
      const ins = n.map((x) => x.text);
      f.lines.splice(at, 0, ...ins);
      if (wasEnd) f.finalBr = !noNewlineAfterLast(h.body, ['+']);
      d += n.length;
    } else {
      const found = findTier(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const touchesEnd = best + o.length === f.lines.length;
      const rep = buildReplacement(f.lines, best, o, n, found.tier);
      f.lines.splice(best, o.length, ...rep);
      if (touchesEnd) f.finalBr = !noNewlineAfterLast(h.body, [' ', '+']);
      d += n.length - o.length;
    }
  }
  return serializeFile(f);
}

function unifiedSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldP = s.hasPair ? s.pairOld : s.renameFrom !== undefined ? s.renameFrom : s.diffOld !== undefined ? s.diffOld : null;
  const newP = s.hasPair ? s.pairNew : s.renameTo !== undefined ? s.renameTo : s.diffNew !== undefined ? s.diffNew : null;
  const isCreate = oldP === null || s.newFile;
  const isDelete = newP === null || s.deletedFile;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noNl = false;
      for (const h of s.hunks) {
        for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      }
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        if (h.body.some((b) => b.kind === '+')) {
          noNl = noNewlineAfterLast(h.body, ['+']);
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    // A change, or a move when the two paths differ.
    const op = oldP!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    const after = applyHunks(before, s.hunks, strict, op);
    if (newP !== null && newP !== op) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(op, null);
      tree.now.set(newP, after);
      tree.moves.push([op, newP]);
    } else {
      tree.now.set(op, after);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const rep = buildReplacement(f.lines, pos, oldLines, n, found.tier);
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, serializeFile(f));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const sectionHead = /^\*\*\* (Add File|Delete File|Update File):(.*)$/;
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const m = sectionHead.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update';
    const path = m[2]!.trim();
    const headerLine = i + 1;
    i += 1;
    const secLines: string[] = [];
    const secNos: number[] = [];
    while (i < last && !sectionHead.test(lines[i]!)) {
      secLines.push(lines[i]!);
      secNos.push(i + 1);
      i += 1;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) {
      secLines.pop();
      secNos.pop();
    }
    if (kind === 'add') {
      const out: string[] = [];
      for (let k = 0; k < secLines.length; k++) {
        const l = secLines[k]!;
        if (l === '') out.push('');
        else if (l.startsWith('+')) out.push(l.slice(1));
        else throw new Exit2(`error: parse ${secNos[k]}`);
      }
      edits.push(v4aAddEdit(path, out));
    } else if (kind === 'delete') {
      for (let k = 0; k < secLines.length; k++) throw new Exit2(`error: parse ${secNos[k]}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let start = 0;
      if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to:')) {
        moveTo = secLines[0]!.slice('*** Move to:'.length).trim();
        start = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (let k = start; k < secLines.length; k++) {
        const l = secLines[k]!;
        if (l.startsWith('@@')) {
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, body: [] };
          chunks.push(cur);
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${secNos[k]}`);
          cur.eof = true;
          cur = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${secNos[k]}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function applyV4aChunks(text: string, chunks: VChunk[], strict: boolean, path: string): string {
  const f = parseFile(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const a = findAnchor(f.lines, ch.anchor, strict, cursor);
      if (a === null) throw new Fail('no-match', path);
      cursor = a.pos + 1;
    }
    const { o, n } = splitBody(ch.body);
    if (o.length === 0) {
      const at = ch.eof ? f.lines.length : cursor;
      const ins = n.map((x) => x.text);
      f.lines.splice(at, 0, ...ins);
      cursor = at + ins.length;
    } else {
      const found = findTier(f.lines, o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      const rep = buildReplacement(f.lines, pos, o, n, found.tier);
      f.lines.splice(pos, o.length, ...rep);
      cursor = pos + rep.length;
    }
  }
  return serializeFile(f);
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const after = applyV4aChunks(before, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, after);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, after);
    }
  };
}

// ---------------------------------------------------------------------------
// Running the patch (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
    writes: Array<{ path: string; value: string | null }>;
  }
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}`, writes: [{ path: oldP, value: null }, { path: newP, value: nowNew }] });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, writes: [{ path: p, value: now }] });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out: string[] = [];
  for (const r of rows) {
    out.push(r.text);
    if (check) continue;
    for (const w of r.writes) {
      if (w.value === null) rmSync(w.path, { force: true });
      else {
        mkdirSync(dirname(w.path), { recursive: true });
        writeFileSync(w.path, w.value);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
