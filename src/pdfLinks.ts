// Hyperlinks of the full-compile PDF. The extension host only owns request state and the bounded
// cache; every file read, completeness check and PDF.js call happens in
// dist/pdf-links.worker.js. The host therefore never bundles PDF.js and never blocks its event
// loop on a long annotation scan.
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  abortError,
  isAbortError,
  PdfLinkError,
  type PdfLinkErrorCode,
  type PdfLinkWorkerRequest,
  type PdfLinkWorkerResponse,
  type PdfLinkWorkerSnapshot,
} from './pdfLinkCore';
import type { PdfLink } from './protocol';

export {
  abortError,
  destinationPoint,
  destinationUserPoint,
  destinationY,
  isAbortError,
  PdfLinkError,
  rectFractions,
  safeLinkUrl,
  viewAspect,
} from './pdfLinkCore';
export type { PdfLinkErrorCode, PdfPoint, PdfUserPoint } from './pdfLinkCore';

export interface PdfLinkExtractorOptions {
  /** Path to pdf-links.worker.js. Defaults to the copy next to this module (dist or out/test). */
  workerFile?: string;
  /** Number of file snapshots kept by the LRU cache. */
  cacheLimit?: number;
  /** Safety net for a wedged worker; 0 disables it. */
  timeoutMs?: number;
}

/** Counters for tests and diagnostics; they are a snapshot, not live state. */
export interface PdfLinkExtractorStats {
  requests: number;
  cacheHits: number;
  workerStarts: number;
  aborts: number;
  failures: number;
}

interface PendingRequest {
  id: number;
  file: string;
  expectedPages: number | undefined;
  promise: Promise<PdfLink[]>;
  resolve: (links: PdfLink[]) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  worker: Worker | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * One instance per preview panel. A new request replaces the in-flight one; cancellation
 * terminates the worker (a synchronous PDF.js scan cannot observe postMessage), and a normal
 * completion leaves the worker idle for the next layout. Pending tasks keep the worker
 * referenced so a test process does not exit before the result arrives; idle workers are
 * unreferenced.
 */
export class PdfLinkExtractor {
  private readonly workerFile: string | undefined;
  private readonly cacheLimit: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, PdfLink[]>();
  private readonly counters: PdfLinkExtractorStats = { requests: 0, cacheHits: 0, workerStarts: 0, aborts: 0, failures: 0 };
  private worker: Worker | undefined;
  private active: PendingRequest | undefined;
  private nextId = 0;
  private disposed = false;

  constructor(options: PdfLinkExtractorOptions = {}) {
    this.workerFile = options.workerFile ? path.resolve(options.workerFile) : undefined;
    const cacheLimit = options.cacheLimit ?? 8;
    this.cacheLimit = Number.isFinite(cacheLimit) ? Math.max(1, Math.floor(cacheLimit)) : 8;
    const timeoutMs = options.timeoutMs ?? 120_000;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 120_000;
  }

  get stats(): PdfLinkExtractorStats {
    return { ...this.counters };
  }

  /**
   * Extract the links of `file`. Repeated calls for the same in-flight file/expectedPages share
   * one promise; a different call replaces the older request, whose promise rejects with an
   * `AbortError`. A complete PDF without links resolves to `[]`; an incomplete or unreadable
   * PDF, a page-count mismatch and every worker failure reject.
   */
  extract(file: string, expectedPages?: number): Promise<PdfLink[]> {
    this.counters.requests++;
    if (this.disposed) return Promise.reject(new PdfLinkError('disposed', 'PDF link extraction service was disposed'));

    const target = path.resolve(file);
    const active = this.active;
    if (active && !active.settled) {
      if (active.file === target && active.expectedPages === expectedPages) return active.promise;
      this.abort(active, 'replaced by a newer PDF link request');
    }

    const pending = this.createPending(target, expectedPages);
    this.active = pending;
    void this.run(pending).catch((error: unknown) => this.fail(pending, error));
    return pending.promise;
  }

  /** Abort the in-flight request. With no request this is a no-op and the idle worker stays. */
  cancel(): void {
    if (this.disposed) return;
    const pending = this.active;
    if (!pending || pending.settled) return;
    this.abort(pending, 'PDF link extraction cancelled');
  }

  /** Terminate the worker and reject any in-flight request. Later extracts reject as disposed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.active;
    if (pending) this.abort(pending, 'PDF link extractor disposed');
    const worker = this.worker;
    if (worker) this.discardWorker(worker);
    this.cache.clear();
  }

  // -------------------------------------------------------------------------------------------

  private createPending(file: string, expectedPages: number | undefined): PendingRequest {
    let resolve!: (links: PdfLink[]) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<PdfLink[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      id: ++this.nextId,
      file,
      expectedPages,
      promise,
      resolve,
      reject,
      settled: false,
      worker: undefined,
      timer: undefined,
    };
  }

  private async run(pending: PendingRequest): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(pending.file);
    } catch (error) {
      if (!pending.settled) {
        this.fail(pending, new PdfLinkError('io', `Could not stat PDF ${pending.file}: ${errorMessage(error)}`, { cause: error }));
      }
      return;
    }
    if (pending.settled) return;

    const key = snapshotKey(pending.file, stat.mtimeMs, stat.size, pending.expectedPages);
    const cached = this.cacheGet(key);
    if (cached) {
      this.counters.cacheHits++;
      this.succeed(pending, cloneLinks(cached));
      return;
    }

    const worker = this.ensureWorker();
    pending.worker = worker;
    worker.ref();
    const request: PdfLinkWorkerRequest = {
      type: 'extract',
      id: pending.id,
      file: pending.file,
      expectedPages: pending.expectedPages,
    };
    this.armTimeout(pending);
    try {
      worker.postMessage(request);
    } catch (error) {
      this.discardWorker(worker);
      throw error;
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const file = this.workerFile ?? defaultWorkerFile();
    if (!existsSync(file)) throw new PdfLinkError('worker', `PDF link worker not found: ${file}`);
    // Annotation extraction needs no native canvas. PDF.js probes optional canvas addons on
    // import; loading and terminating them in workers can crash the process on Windows.
    // Without the addon, pdf.js prints canvas polyfill warnings on import: drop the worker's
    // stdout (errors come back as messages).
    const worker = new Worker(file, { execArgv: ['--no-addons'], stdout: true });
    worker.stdout.resume();
    this.counters.workerStarts++;
    worker.on('message', (message: PdfLinkWorkerResponse) => this.onMessage(worker, message));
    worker.on('messageerror', (error: Error) => {
      this.onWorkerFailure(worker, new PdfLinkError('worker', `PDF link worker message failed: ${errorMessage(error)}`, { cause: error }));
    });
    worker.on('error', (error: Error) => {
      this.onWorkerFailure(worker, new PdfLinkError('worker', `PDF link worker failed: ${errorMessage(error)}`, { cause: error }));
    });
    worker.on('exit', (code: number) => this.onWorkerExit(worker, code));
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private onMessage(worker: Worker, message: PdfLinkWorkerResponse): void {
    const pending = this.active;
    if (!pending || pending.settled || pending.worker !== worker || !message || message.id !== pending.id) return;
    if (message.type === 'result') {
      if (!Array.isArray(message.links) || !validSnapshot(message.snapshot)) {
        this.discardWorker(worker);
        this.fail(pending, new PdfLinkError('worker', 'PDF link worker returned an invalid result'));
        return;
      }
      worker.unref();
      this.remember(snapshotKey(pending.file, message.snapshot.mtimeMs, message.snapshot.size, pending.expectedPages), message.links);
      this.succeed(pending, message.links);
      return;
    }
    if (message.type === 'error') {
      this.discardWorker(worker);
      this.fail(pending, new PdfLinkError(message.code ?? 'parse', message.message || 'PDF link extraction failed'));
    }
  }

  private onWorkerFailure(worker: Worker, error: PdfLinkError): void {
    const pending = this.active;
    this.discardWorker(worker);
    if (pending && !pending.settled && pending.worker === worker) this.fail(pending, error);
  }

  private onWorkerExit(worker: Worker, code: number): void {
    this.forgetWorker(worker);
    const pending = this.active;
    if (pending && !pending.settled && pending.worker === worker) {
      this.fail(pending, new PdfLinkError('worker', `PDF link worker exited with code ${code}`));
    }
  }

  private abort(pending: PendingRequest, message: string): void {
    if (pending.settled) return;
    this.counters.aborts++;
    this.reject(pending, abortError(message));
    if (pending.worker) this.discardWorker(pending.worker);
  }

  private succeed(pending: PendingRequest, links: PdfLink[]): void {
    if (pending.settled) return;
    pending.settled = true;
    this.clearTimeout(pending);
    if (this.active === pending) this.active = undefined;
    pending.resolve(links);
  }

  private fail(pending: PendingRequest, error: unknown): void {
    if (pending.settled) return;
    const normalized =
      error instanceof PdfLinkError || isAbortError(error)
        ? error
        : new PdfLinkError('worker', `PDF link extraction failed: ${errorMessage(error)}`, { cause: error });
    this.reject(pending, normalized);
  }

  private reject(pending: PendingRequest, error: unknown): void {
    if (pending.settled) return;
    pending.settled = true;
    this.clearTimeout(pending);
    if (this.active === pending) this.active = undefined;
    if (!isAbortError(error)) this.counters.failures++;
    pending.reject(error);
  }

  private armTimeout(pending: PendingRequest): void {
    if (this.timeoutMs <= 0) return;
    pending.timer = setTimeout(() => {
      if (pending.settled) return;
      if (pending.worker) this.discardWorker(pending.worker);
      this.fail(pending, new PdfLinkError('worker', `PDF link extraction timed out after ${this.timeoutMs} ms`));
    }, this.timeoutMs);
    pending.timer.unref?.();
  }

  private clearTimeout(pending: PendingRequest): void {
    if (!pending.timer) return;
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }

  private forgetWorker(worker: Worker): void {
    if (this.worker === worker) this.worker = undefined;
    worker.removeAllListeners();
  }

  private discardWorker(worker: Worker): void {
    this.forgetWorker(worker);
    void worker.terminate().catch(() => undefined);
  }

  private cacheGet(key: string): PdfLink[] | undefined {
    const links = this.cache.get(key);
    if (!links) return undefined;
    // Refresh LRU order.
    this.cache.delete(key);
    this.cache.set(key, links);
    return links;
  }

  private remember(key: string, links: PdfLink[]): void {
    this.cache.delete(key);
    this.cache.set(key, cloneLinks(links));
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}

/** Compatibility entry point for callers that only need one extraction. */
export async function extractPdfLinks(file: string): Promise<PdfLink[]> {
  const extractor = new PdfLinkExtractor();
  try {
    return await extractor.extract(file);
  } finally {
    extractor.dispose();
  }
}

function defaultWorkerFile(): string {
  const candidates = [
    path.join(__dirname, 'pdf-links.worker.js'), // dist/, out/test/, out/perf/
    path.join(__dirname, '..', 'dist', 'pdf-links.worker.js'), // a test bundle outside dist
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new PdfLinkError('worker', `PDF link worker is missing (looked in ${candidates.join(', ')})`);
  return file;
}

function snapshotKey(file: string, mtimeMs: number, size: number, expectedPages: number | undefined): string {
  return `${file}\u0000${mtimeMs}\u0000${size}\u0000${expectedPages ?? ''}`;
}

function validSnapshot(snapshot: PdfLinkWorkerSnapshot | undefined): snapshot is PdfLinkWorkerSnapshot {
  return (
    !!snapshot &&
    typeof snapshot.mtimeMs === 'number' &&
    Number.isFinite(snapshot.mtimeMs) &&
    typeof snapshot.size === 'number' &&
    Number.isInteger(snapshot.size) &&
    snapshot.size >= 0
  );
}

function cloneLinks(links: readonly PdfLink[]): PdfLink[] {
  return links.map((link) => ({
    ...link,
    ...(link.userRect ? { userRect: [...link.userRect] as [number, number, number, number] } : {}),
    target: { ...link.target },
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
