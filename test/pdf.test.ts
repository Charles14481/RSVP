import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfText, PdfError } from '../src/ingest/pdf';
import { buildLines, dropFurniture, joinLines, layoutPdf, NoTextLayerError, splitColumns, type Line, type PdfTextItem } from '../src/ingest/pdfLayout';
import { flow, makePdf, type Run } from './helpers/pdfWriter';

/** A synthetic item whose width is estimated at half an em per character. */
const item = (str: string, x: number, y: number, size = 10): PdfTextItem => ({ str, x, y, size, fontSize: size, width: str.length * size * 0.5 }) as PdfTextItem;

describe('buildLines', () => {
  it('groups items by baseline and orders them by x, adding spaces at gaps', () => {
    const lines = buildLines([item('world', 60, 700), item('Hello', 20, 701), item('Next', 20, 686), item('line.', 45, 686)], 0, 0);
    expect(lines.map((l) => l.text)).toEqual(['Hello world', 'Next line.']);
  });

  it('does not add spaces between touching items', () => {
    const a = item('exam', 20, 700);
    const b = item('ple', 20 + a.width, 700);
    expect(buildLines([a, b], 0, 0)[0].text).toBe('example');
  });
});

describe('splitColumns', () => {
  const twoCols = () => {
    const items: PdfTextItem[] = [item('A Centered Title Spanning The Gutter', 200, 760, 14)];
    for (let k = 0; k < 20; k++) {
      items.push(item(`left column line ${k} text`, 50, 700 - k * 13));
      items.push(item(`right column line ${k} text`, 330, 700 - k * 13));
    }
    return items;
  };

  it('splits a page with a clear gutter into title, left, right', () => {
    const { groups, twoColumn } = splitColumns({ width: 612, height: 792, items: twoCols() });
    expect(twoColumn).toBe(true);
    expect(groups[0].map((i) => i.str)).toEqual(['A Centered Title Spanning The Gutter']);
    expect(groups[1].every((i) => i.str.startsWith('left'))).toBe(true);
    expect(groups[2].every((i) => i.str.startsWith('right'))).toBe(true);
  });

  it('leaves single-column pages alone', () => {
    const items: PdfTextItem[] = [];
    for (let k = 0; k < 30; k++) items.push(item('a full width line of body text that runs across the page center', 50, 700 - k * 13));
    expect(splitColumns({ width: 612, height: 792, items }).twoColumn).toBe(false);
  });
});

describe('dropFurniture', () => {
  const page = (p: number, body: string[]): Line[] => {
    const lines: Line[] = [{ text: 'Journal of Tests, Vol. 3', x: 50, right: 300, y: 760, fontSize: 9, page: p, block: p }];
    body.forEach((t, k) => lines.push({ text: t, x: 50, right: 500, y: 700 - k * 13, fontSize: 10, page: p, block: p }));
    lines.push({ text: String(p + 1), x: 300, right: 310, y: 40, fontSize: 9, page: p, block: p });
    return lines;
  };

  it('drops repeated headers and page numbers but keeps body text', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
    const pages = [0, 1, 2, 3].map((p) => page(p, [0, 1, 2].map((k) => `Body ${words[p * 3 + k]} text.`)));
    const out = dropFurniture(pages);
    expect(out.headers).toBe(4);
    expect(out.pageNumbers).toBe(4);
    expect(out.pages.flat().map((l) => l.text)).toEqual(pages.flat().map((l) => l.text).filter((t) => t.startsWith('Body')));
  });

  it('keeps edge lines that do not repeat', () => {
    const pages = [page(0, ['Only page.'])];
    expect(dropFurniture(pages).pages[0].map((l) => l.text)).toEqual(['Journal of Tests, Vol. 3', 'Only page.']);
  });
});

describe('joinLines', () => {
  const L = (text: string, y: number, x = 50, right = 500, fontSize = 10, block = 0): Line => ({ text, x, right, y, fontSize, page: 0, block });

  it('joins wrapped lines and breaks at gaps, indents, short lines and headings', () => {
    const lines = [
      L('Heading', 760, 50, 120, 16),
      L('First paragraph runs across', 730),
      L('two lines here.', 717, 50, 200),
      L('Second paragraph after a short', 704, 68),
      L('line, still going and', 691),
      L('ends.', 678, 50, 90),
      L('Third after a gap.', 640, 50, 490),
    ];
    expect(joinLines(lines).text.split('\n\n')).toEqual([
      'Heading',
      'First paragraph runs across two lines here.',
      'Second paragraph after a short line, still going and ends.',
      'Third after a gap.',
    ]);
  });

  it('rejoins hyphenated words and keeps hyphens before capitals and digits', () => {
    const lines = [L('an experi-', 700), L('ment with Anglo-', 687), L('Saxon and COVID-', 674), L('19 data.', 661, 50, 120)];
    const { text, rejoined } = joinLines(lines);
    expect(text).toBe('an experiment with Anglo-Saxon and COVID-19 data.');
    expect(rejoined).toBe(1);
  });
});

describe('layoutPdf', () => {
  it('reports a document without a text layer', () => {
    expect(() => layoutPdf([{ width: 612, height: 792, items: [] }, { width: 612, height: 792, items: [item(' ', 0, 0)] }])).toThrow(NoTextLayerError);
  });

  it('notes pages without text', () => {
    const items = [item('Some text here.', 50, 700)];
    const r = layoutPdf([{ width: 612, height: 792, items }, { width: 612, height: 792, items: [] }]);
    expect(r.emptyPages).toBe(1);
    expect(r.notes.join(' ')).toMatch(/1 page had no text layer/);
  });
});

describe('PDF extraction through pdf.js', () => {
  const P = [
    'Reading one word at a time removes the eye movements of ordinary reading, but it also removes the chance to look back. Readers of rapid serial presentation lose most when a sentence takes an unexpected turn and they cannot return to it.',
    'This study measured how long readers needed for each word when the pace followed the predictability of the text rather than a fixed clock, and whether comprehension held up when the experiment ran for a full hour at a time without a break of any kind for the volunteers taking part in the study, and',
    'whether they read faster at the end of the session than at its start.',
    'Left column paragraph one talks about the methods used in the study and the materials that were prepared.',
    'Left column paragraph two continues with the procedure that every participant followed.',
    'The right column holds the results, which were clear enough that no further analysis was needed.',
    'Conclusion',
    'Pacing by surprisal is simple to build and easy to tune, and readers preferred it.',
  ];

  function document(): Uint8Array {
    const header = (p: number): Run[] => [
      { text: 'Proceedings of the Test Society', x: 72, y: 760, size: 9 },
      { text: String(p), x: 300, y: 36, size: 9 },
    ];
    // Page 1: title, P0, then P1 starting with a hyphenated word and running onto page 2.
    const p1: Run[] = [...header(1), { text: 'A Study of Pacing', x: 72, y: 710, size: 18 }];
    const body1 = flow([P[0]], { x: 72, y: 670, chars: 80, indent: 18 });
    p1.push(...body1.runs);
    let y = body1.y;
    const hyphenLines = [
      'This study measured how long readers needed for each word when the pace',
      'followed the predictability of the text rather than a fixed clock, and wheth-',
      'er comprehension held up when the experiment ran for a full hour at a time',
      'without a break of any kind for the volunteers taking part in the study, and',
    ];
    hyphenLines.forEach((t, k) => {
      p1.push({ text: t, x: 72 + (k === 0 ? 18 : 0), y, size: 11 });
      y -= 11 * 1.3;
    });
    // Page 2: the paragraph continues (no indent), then ends.
    const p2: Run[] = [...header(2), ...flow([P[2]], { x: 72, y: 700, chars: 80 }).runs];
    // Page 3: two columns.
    const left = flow([P[3], P[4]], { x: 72, y: 700, chars: 38, size: 10, indent: 12 });
    const right = flow([P[5]], { x: 330, y: 700, chars: 38, size: 10, indent: 12 });
    const padLeft = flow(['Filler text keeps the left column long enough to look like a real column of text on a page.'], {
      x: 72,
      y: left.y,
      chars: 38,
      size: 10,
      indent: 12,
    });
    const padRight = flow(['More filler for the right column so both sides have plenty of lines in them for detection.'], {
      x: 330,
      y: right.y,
      chars: 38,
      size: 10,
      indent: 12,
    });
    const p3: Run[] = [...header(3), ...left.runs, ...padLeft.runs, ...right.runs, ...padRight.runs];
    // Page 4: heading and closing paragraph.
    const p4: Run[] = [...header(4), { text: P[6], x: 72, y: 700, size: 14 }, ...flow([P[7]], { x: 72, y: 670, chars: 80, indent: 18 }).runs];
    return makePdf([{ runs: p1 }, { runs: p2 }, { runs: p3 }, { runs: p4 }], 'Pacing Study');
  }

  it('rebuilds paragraphs, columns and hyphenation and drops furniture', async () => {
    const result = await extractPdfText(pdfjs, document());
    const paragraphs = result.text.split('\n\n');
    expect(result.title).toBe('Pacing Study');
    expect(paragraphs[0]).toBe('A Study of Pacing');
    expect(paragraphs[1]).toBe(P[0]);
    // P1 and P2 are one paragraph split across the page break, with "wheth-er" rejoined.
    expect(paragraphs[2]).toBe(`${P[1]} ${P[2]}`);
    expect(paragraphs[3]).toBe(P[3]);
    expect(paragraphs[4]).toBe(P[4]);
    expect(paragraphs[5]).toMatch(/^Filler text/);
    expect(paragraphs[6]).toBe(P[5]);
    expect(paragraphs[7]).toMatch(/^More filler/);
    expect(paragraphs.slice(8)).toEqual([P[6], P[7]]);
    expect(result.text).not.toMatch(/Proceedings/);
    expect(result.notes.join(' ')).toMatch(/4 repeated header/);
    expect(result.notes.join(' ')).toMatch(/4 page numbers/);
    expect(result.notes.join(' ')).toMatch(/1 page as two columns/);
    expect(result.notes.join(' ')).toMatch(/Rejoined 1 word/);
  });

  it('reports invalid files', async () => {
    await expect(extractPdfText(pdfjs, new TextEncoder().encode('not a pdf'))).rejects.toBeInstanceOf(PdfError);
  });
});
