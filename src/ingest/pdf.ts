import type * as Pdfjs from 'pdfjs-dist';
import { layoutPdf, type LayoutResult, type PdfPage, type PdfTextItem } from './pdfLayout';

export type PdfjsLib = Pick<typeof Pdfjs, 'getDocument'>;

export interface PdfExtract extends LayoutResult {
  /** Title from the document metadata, if any. */
  title?: string;
}

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfError';
  }
}

/**
 * Extract positioned text from every page with pdf.js, then lay it out.
 * Takes the pdf.js module so the same code runs in the browser (with its
 * worker) and in Node tests (legacy build).
 */
export async function extractPdfText(
  pdfjs: PdfjsLib,
  data: Uint8Array,
  onProgress?: (page: number, pages: number) => void,
): Promise<PdfExtract> {
  const task = pdfjs.getDocument({ data, useSystemFonts: false });
  let doc: Pdfjs.PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    const name = (e as { name?: string })?.name;
    if (name === 'PasswordException') throw new PdfError('This PDF is password-protected. Open it elsewhere and paste the text instead.');
    if (name === 'InvalidPDFException') throw new PdfError('This file is not a valid PDF.');
    throw new PdfError(`Could not open the PDF: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const pages: PdfPage[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      onProgress?.(p, doc.numPages);
      const page = await doc.getPage(p);
      const [x0, y0, x1, y1] = page.view;
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const it of content.items) {
        if (!('str' in it) || !it.str) continue;
        if (it.dir === 'ttb') continue;
        const [a, b, c, d, e, f] = it.transform as number[];
        // Skip rotated text (watermarks, sideways margin notes).
        if (Math.abs(b) > Math.abs(a) * 0.1 || Math.abs(c) > Math.abs(d) * 0.1) continue;
        items.push({ str: it.str, x: e - x0, y: f - y0, width: it.width, fontSize: Math.hypot(c, d) || it.height || 10 });
      }
      pages.push({ width: x1 - x0, height: y1 - y0, items });
      page.cleanup();
    }
    const result = layoutPdf(pages);
    const meta = await doc.getMetadata().catch(() => null);
    const title = (meta?.info as { Title?: unknown } | undefined)?.Title;
    return { ...result, ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}) };
  } finally {
    void task.destroy();
  }
}
