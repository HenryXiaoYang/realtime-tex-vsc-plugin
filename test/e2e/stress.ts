// A document of unique words in the constructs where a click is hard to map, and a check that
// clicks every character of every word in the preview and compares where the cursor lands.
import type { PdfWord } from '../../src/messages';
import { glyphTextOf, unitRows, type GlyphText } from '../../src/glyphMap';
import type { PreviewModel } from '../../webview/model';

// each @ becomes a word of its own (zq + two letters: no ligatures, no hyphenation)
const CONSTRUCTS: [string, string][] = [
  ['paragraph', 'Plain @ @ text with \\textbf{@}, \\emph{@ @}, \\texttt{@} and ``@\'\' quotes---and @--@ dashes.'],
  ['link and ref', 'See Section~\\ref{sec:zz} and \\href{https://example.com}{@ @}, then @.'],
  ['footnote', 'A footnote mark@\\footnote{Footnote @ @.} and @ after it.'],
  ['heading', '\\section{@ @}\\label{sec:zz}\n@ under the heading.'],
  ['itemize', '\\begin{itemize}\n  \\item @ @\n  \\item @ \\textbf{@}\n\\end{itemize}'],
  ['enumerate', '\\begin{enumerate}\n  \\item @\n  \\item @ @\n\\end{enumerate}'],
  ['description', '\\begin{description}\n  \\item[@] @ @\n\\end{description}'],
  ['inline math', 'Math $\\text{@} + x^2$ and $a_{\\text{@}}$ then @.'],
  ['display math', '\\[ \\text{@} = \\frac{a}{b} \\quad \\text{@} \\]\n@ after the display.'],
  ['align', '\\begin{align}\n  y &= x \\quad \\text{@} \\\\\n  z &= w \\quad \\text{@}\n\\end{align}'],
  [
    'table',
    '\\begin{table}[h]\n\\centering\n\\begin{tabular}{lll}\n\\toprule\n@ & @ & @ \\\\\n\\midrule\n\\multicolumn{2}{c}{@ @} & @ \\\\\n@ & \\textbf{@} & @ \\\\\n\\bottomrule\n\\end{tabular}\n\\caption{@ @}\n\\end{table}',
  ],
  ['minipages', '\\noindent\\begin{minipage}{0.45\\textwidth}\n@ @ left\n\\end{minipage}\\hfill\n\\begin{minipage}{0.45\\textwidth}\n@ @ right\n\\end{minipage}'],
  ['boxes', 'Boxes \\fbox{@} and \\mbox{@ @} and \\parbox{3cm}{@ @} done.'],
  ['quote', '\\begin{quote}\n@ @ quoted.\n\\end{quote}'],
  ['center', '\\begin{center}\n@ centred @\n\\end{center}'],
  ['theorem', '\\begin{theorem}[@]\n@ @ holds.\n\\end{theorem}'],
  ['verbatim', 'Inline \\verb|@| and\n\\begin{verbatim}\n@ verbatim\n\\end{verbatim}'],
  ['figure caption', '\\begin{figure}[h]\n\\centering\n\\fbox{@}\n\\caption{@ @}\n\\end{figure}'],
  ['multicol', '\\begin{multicols}{2}\n' + 'Columns @ @ @ and @ @ @, '.repeat(4) + '\n\\end{multicols}'],
  ['marginpar', 'A margin note\\marginpar{@ @} and @ next to it.'],
  ['hyphenation', 'Narrow \\parbox{2.2cm}{@L and @L and @L} box.'],
  ['repeated', 'The same word @R, then @R and @R again; @R ends it.'],
  ['tikz', '\\begin{center}\n\\begin{tikzpicture}\n  \\node at (0,0) {@ @};\n  \\draw (1,0) -- (3,0) node[right] {@};\n  \\node[draw] at (5,1) {$\\text{@}$};\n\\end{tikzpicture}\n\\end{center}'],
];

const LETTERS = 'abcdeghjkmnoprstuvwy';

export interface StressDoc {
  tex: string;
  /** Each word and the construct it is in. */
  words: Map<string, string>;
}

export function stressDoc(): StressDoc {
  const words = new Map<string, string>();
  let n = 0;
  const next = (construct: string) => {
    const w = `zq${LETTERS[Math.floor(n / LETTERS.length)]}${LETTERS[n % LETTERS.length]}`;
    n++;
    words.set(w, construct);
    return w;
  };
  // @L: a long word TeX hyphenates; @R: one word used for every @R of its construct
  const body = CONSTRUCTS.map(([name, t]) => {
    let same: string | undefined;
    return t.replace(/@([LR]?)/g, (_, kind: string) => {
      if (kind === 'R') return (same ??= next(name));
      if (kind !== 'L') return next(name);
      const w = `${next(name)}internationalization`;
      words.set(w, name);
      words.delete(w.slice(0, 4));
      return w;
    });
  }).join('\n\n');
  const tex = `\\documentclass{article}\n\\usepackage{amsmath,amsthm,booktabs,tikz,multicol,hyperref}\n\\newtheorem{theorem}{Theorem}\n\\begin{document}\n${body}\n\\end{document}\n`;
  return { tex, words };
}

export interface ClickMiss {
  word: string;
  construct: string;
  char: number;
  got: string;
}

type SourceAt = (page: number, x: number, y: number, pdfText?: PdfWord[]) => Promise<{ offset: number; exact: boolean } | undefined>;
type TargetAt = (offset: number) => Promise<{ page: number; x: number; y: number; size?: number } | undefined>;

/** Where `word` occurs in `gt`, across a hyphenated line break ("inter- nationalization"): the
 * glyph text index of each of its characters, per occurrence. */
function occurrences(gt: GlyphText, word: string): number[][] {
  const map: number[] = [];
  let norm = '';
  for (let i = 0; i < gt.text.length; i++) {
    if (gt.text[i] === '-' && gt.text[i + 1] === ' ') {
      i++;
      continue;
    }
    norm += gt.text[i];
    map.push(i);
  }
  const out: number[][] = [];
  for (let k = norm.indexOf(word); k >= 0; k = norm.indexOf(word, k + 1)) out.push([...word].map((_, i) => map[k + i]));
  return out;
}

/**
 * Click every character of every word where the preview shows it, and put the source cursor on
 * every character to check the preview's caret lands on it, (display-list glyphs, else the
 * page's PDF text) and compare the source offset with the word's own: the j-th time a word is
 * shown is its j-th time in the source. Returns the misses and the words not shown as often as
 * the source has them.
 */
export async function clickEveryWord(
  model: PreviewModel,
  src: string,
  doc: StressDoc,
  pdfText: Map<number, PdfWord[]>,
  sourceAt: SourceAt,
  targetAt: TargetAt,
): Promise<{ clicks: number; misses: ClickMiss[]; unseen: string[]; carets: number; caretMisses: ClickMiss[] }> {
  const misses: ClickMiss[] = [];
  const caretMisses: ClickMiss[] = [];
  let carets = 0;
  const unseen: string[] = [];
  let clicks = 0;
  for (const [word, construct] of doc.words) {
    const inSource: number[] = [];
    for (let k = src.indexOf(word); k >= 0; k = src.indexOf(word, k + 1)) inSource.push(k);
    // each time the word is shown: [page, x, y] at 30 % of each of its glyphs, and the
    // character's left edge and baseline (for the caret), or none when only the PDF has it
    const shown: [number, number, number, number?, number?][][] = [];
    for (let page = 1; page <= model.pagesTotal; page++) {
      const pu = model.pages.get(page)!;
      const units = unitRows(model, page);
      const owned = new Set(model.hiddenLines(page));
      for (const id of units.keys()) for (const i of model.ownLines(page, id)) owned.add(i);
      const groups = [...units.values(), ...pu.dl.lines.filter((_, i) => !owned.has(i)).map((line) => [{ dl: pu.dl, line, dx: 0, dy: 0 }])];
      const before = shown.length;
      for (const rows of groups) {
        const gt = glyphTextOf(rows);
        for (const occ of occurrences(gt, word)) {
          shown.push(
            occ.map((j) => {
              const g = gt.glyphs.find((g) => g.start <= j && j < g.start + g.text.length)!;
              return [page, g.x + g.adv * ((j - g.start + 0.3) / g.text.length), g.y - g.size * 0.2, g.x + (g.adv * (j - g.start)) / g.text.length, g.y];
            }),
          );
        }
      }
      if (shown.length > before) continue;
      // only the PDF has it (a TikZ label)
      for (const run of pdfText.get(page) ?? []) {
        const k = run.text.indexOf(word);
        if (k < 0) continue;
        const adv = run.w / [...run.text].length;
        shown.push([...word].map((_, i) => [page, run.x + (k + i + 0.3) * adv, run.y - run.size * 0.2]));
      }
    }
    if (shown.length !== inSource.length) {
      unseen.push(`${word} (${construct}): shown ${shown.length}, in the source ${inSource.length}`);
      continue;
    }
    for (let j = 0; j < shown.length; j++) {
      for (let i = 0; i < word.length; i++) {
        const [page, x, y, left, base] = shown[j][i];
        // the cursor on that character in the source: the preview's caret at its left edge
        if (left !== undefined && base !== undefined) {
          carets++;
          const t = await targetAt(inSource[j] + i);
          if (!t || t.size === undefined || t.page !== page || Math.abs(t.x - left) > 32768 || Math.abs(t.y - base) > 32768) {
            caretMisses.push({ word: j ? `${word}#${j + 1}` : word, construct, char: i, got: t ? `${t.size === undefined ? '(row) ' : ''}page ${t.page} (${(t.x / 65536).toFixed(1)}, ${(t.y / 65536).toFixed(1)})pt, want page ${page} (${(left / 65536).toFixed(1)}, ${(base / 65536).toFixed(1)})pt` : 'nothing' });
          }
        }
        clicks++;
        const res = await sourceAt(page, x, y, pdfText.get(page));
        if (res?.exact && res.offset === inSource[j] + i) continue;
        misses.push({ word: j ? `${word}#${j + 1}` : word, construct, char: i, got: res ? `${res.exact ? '' : '(estimate) '}${JSON.stringify(src.slice(res.offset - 12, res.offset))}|${JSON.stringify(src.slice(res.offset, res.offset + 12))}` : 'nothing' });
      }
    }
  }
  return { clicks, misses, unseen, carets, caretMisses };
}
