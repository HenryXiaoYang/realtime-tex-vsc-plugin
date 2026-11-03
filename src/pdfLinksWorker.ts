// Entry point of dist/pdf-links.worker.js. PDF.js initialization, file reading, completeness
// checks and every page/destination conversion happen on this thread, never on the extension
// host. The host cancels by terminating the thread, so a long synchronous parse cannot ignore
// a cancel message.
import { promises as fs } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { PdfLinkError, type PdfLinkWorkerRequest, type PdfLinkWorkerResponse } from './pdfLinkCore';
import { readPdfLinks } from './pdfLinksParse';

if (!parentPort) throw new Error('pdf-links.worker.js must be started as a worker thread');

const port = parentPort;

port.on('message', (message: PdfLinkWorkerRequest) => {
  if (!message || message.type !== 'extract' || !Number.isInteger(message.id) || typeof message.file !== 'string') return;
  void handle(message).then(
    (response) => port.postMessage(response),
    (error: unknown) => port.postMessage(failure(message.id, error)),
  );
});

async function handle(request: PdfLinkWorkerRequest): Promise<PdfLinkWorkerResponse> {
  const snapshot = await readStableSnapshot(request.file);
  const links = await readPdfLinks(snapshot.data, request.expectedPages);
  return {
    type: 'result',
    id: request.id,
    links,
    snapshot: { mtimeMs: snapshot.mtimeMs, size: snapshot.size },
  };
}

const ATTEMPTS = 3;

/**
 * Read a PDF that agrees with itself: stat before and after the read, require the same
 * mtime/size, require the bytes we read to be that size, and require a PDF trailer. A file
 * caught mid-write is retried a bounded number of times; after that it rejects, so the panel
 * never mistakes a partial write for a link-free PDF.
 */
async function readStableSnapshot(file: string): Promise<{ data: Uint8Array; mtimeMs: number; size: number }> {
  let lastError: PdfLinkError | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const before = await fs.stat(file);
      if (!before.isFile()) throw new PdfLinkError('io', `PDF is not a regular file: ${file}`);
      const data = await fs.readFile(file);
      const after = await fs.stat(file);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || data.length !== after.size) {
        lastError = new PdfLinkError('incomplete', `PDF changed while it was read: ${file}`);
      } else if (!hasTrailer(data)) {
        lastError = new PdfLinkError('incomplete', `PDF is incomplete (no %%EOF): ${file}`);
      } else {
        // Copy out of the Node Buffer pool before pdf.js takes ownership of the array buffer.
        return { data: new Uint8Array(data), mtimeMs: after.mtimeMs, size: after.size };
      }
    } catch (error) {
      if (error instanceof PdfLinkError) throw error;
      throw new PdfLinkError('io', `Could not read PDF ${file}: ${errorMessage(error)}`, { cause: error });
    }
    if (attempt < ATTEMPTS) await delay(40 * attempt);
  }
  throw lastError ?? new PdfLinkError('incomplete', `PDF is incomplete: ${file}`);
}

function hasTrailer(data: Uint8Array): boolean {
  const tail = Buffer.from(data.subarray(Math.max(0, data.length - 1024))).toString('latin1');
  return tail.includes('%%EOF');
}

function failure(id: number, error: unknown): PdfLinkWorkerResponse {
  return {
    type: 'error',
    id,
    code: error instanceof PdfLinkError ? error.code : 'parse',
    message: errorMessage(error),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
