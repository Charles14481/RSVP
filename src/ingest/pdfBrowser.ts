import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { extractPdfText, type PdfExtract } from './pdf';

/** Load pdf.js on demand (it is large) and extract a PDF file's text. */
export async function extractPdfFile(file: File, onProgress?: (page: number, pages: number) => void): Promise<PdfExtract> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const data = new Uint8Array(await file.arrayBuffer());
  return extractPdfText(pdfjs, data, onProgress);
}
