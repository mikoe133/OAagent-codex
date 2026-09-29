// Runs in a bounded child process. Never follows links or executes document content.
import { readFile } from 'node:fs/promises';
const [filename, name] = process.argv.slice(2);
const buffer = await readFile(filename);
let text = '';
if (/\.docx$/i.test(name)) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  if (entries.length > 5000) throw new Error('Too many document entries');
  let expanded = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    await new Promise((resolve, reject) => {
      const stream = entry.nodeStream();
      stream.on('data', chunk => {
        expanded += chunk.length;
        if (expanded > 64 * 1024 * 1024) {
          stream.destroy();
          reject(new Error('Expanded document exceeds limit'));
        }
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  }
  const mammoth = await import('mammoth');
  text = (await mammoth.default.extractRawText({ buffer }, { externalFileAccess: false })).value;
} else if (/\.pdf$/i.test(name)) {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdf.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  const document = await loadingTask.promise;
  for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 100) && text.length < 24000; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str ?? '').join(' ') + '\n';
    page.cleanup();
  }
  if (document.numPages > 100 && text.trim()) text += '\n[最多解析前 100 页]';
  await loadingTask.destroy();
}
process.stdout.write(text.slice(0, 24000) + (text.length > 24000 ? '\n[文字已截断，仅分析前 24000 字符]' : ''));
