/**
 * A minimal PDF writer for test fixtures: pages of text runs placed at exact
 * coordinates in Helvetica, so pdf.js can be exercised on known layouts.
 */
export interface Run {
  text: string;
  x: number;
  y: number;
  size?: number;
}

export interface PageSpec {
  width?: number;
  height?: number;
  runs: Run[];
}

function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (code >= 32 && code < 127) out += ch;
    else if (code < 256) out += '\\' + code.toString(8).padStart(3, '0');
    else out += '?';
  }
  return out + ')';
}

export function makePdf(pages: PageSpec[], title?: string): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const info = title ? add(`<< /Title ${pdfString(title)} >>`) : 0;
  const kids: number[] = [];
  for (const page of pages) {
    const w = page.width ?? 612;
    const h = page.height ?? 792;
    const ops = page.runs.map((r) => `BT /F1 ${r.size ?? 11} Tf ${r.x} ${r.y} Td ${pdfString(r.text)} Tj ET`).join('\n');
    const stream = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  // Latin-1 bytes; the writer only emits ASCII.
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

/** Lay out paragraphs as lines of at most `chars` characters, top-down from y, with first-line indents. */
export function flow(
  paragraphs: string[],
  opts: { x: number; y: number; chars: number; size?: number; leading?: number; indent?: number; paragraphGap?: number },
): { runs: Run[]; y: number } {
  const size = opts.size ?? 11;
  const leading = opts.leading ?? size * 1.3;
  const runs: Run[] = [];
  let y = opts.y;
  for (const p of paragraphs) {
    const words = p.split(' ');
    let line = '';
    let first = true;
    const emit = () => {
      runs.push({ text: line, x: opts.x + (first ? opts.indent ?? 0 : 0), y, size });
      y -= leading;
      first = false;
      line = '';
    };
    for (const w of words) {
      if (line && line.length + 1 + w.length > opts.chars) emit();
      line = line ? `${line} ${w}` : w;
    }
    if (line) emit();
    y -= opts.paragraphGap ?? 0;
  }
  return { runs, y };
}
