// The `rtex serve` child process: JSON lines in, events and in-order replies out.
// No vscode imports, so it can be driven from plain node scripts and tests.
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as readline from 'readline';
import type { Command, Reply, RtexEvent } from './protocol';

export interface RtexProcessOptions {
  serverPath: string;
  projectRoot: string;
  mainFile: string;
  buildDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Spawn failure (e.g. ENOENT when the binary is missing). */
  error?: NodeJS.ErrnoException;
  /** Last lines the process wrote to stderr. */
  stderrTail: string[];
  /** True when the exit was requested with `stop()`. */
  requested: boolean;
}

interface Pending {
  resolve(r: Reply): void;
  reject(e: Error): void;
}

export class RtexProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: Pending[] = [];
  private stderrTail: string[] = [];
  private stopping = false;
  private exited = false;

  constructor(private readonly opts: RtexProcessOptions) {
    super();
  }

  /** Emits 'event' (RtexEvent), 'stderr' (line), 'exit' (ExitInfo). */
  start(): void {
    const args = ['serve', '--project', this.opts.projectRoot, '--main', this.opts.mainFile];
    if (this.opts.buildDir) args.push('--build', this.opts.buildDir);
    const child = spawn(this.opts.serverPath, args, {
      cwd: this.opts.projectRoot,
      env: this.opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdin.on('error', () => {
      /* reported through 'exit' */
    });
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      this.emit('stderr', line);
    });
    child.on('error', (error: NodeJS.ErrnoException) => this.finish({ code: null, signal: null, error }));
    child.on('exit', (code, signal) => this.finish({ code, signal }));
  }

  get running(): boolean {
    return this.child !== undefined && !this.exited;
  }

  /** Send a command and wait for its reply. */
  request(cmd: Command): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (!this.running) {
        reject(new Error('rtex is not running'));
        return;
      }
      this.pending.push({ resolve, reject });
      this.write(cmd);
    });
  }

  /** Send a command; its reply is handed to `onReply` (errors are passed as replies too). */
  send(cmd: Command, onReply?: (r: Reply) => void): void {
    this.request(cmd).then(
      (r) => onReply?.(r),
      () => undefined,
    );
  }

  /** Ask the server to quit; kill it if it has not exited after `graceMs`. */
  stop(graceMs = 2000): Promise<void> {
    return new Promise((resolve) => {
      if (!this.running) {
        resolve();
        return;
      }
      this.stopping = true;
      const child = this.child!;
      const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.write({ cmd: 'quit' });
      child.stdin.end();
    });
  }

  private write(cmd: Command): void {
    try {
      this.child?.stdin.write(JSON.stringify(cmd) + '\n');
    } catch {
      /* reported through 'exit' */
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('stderr', `unparsable output: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof msg.event === 'string') {
      this.emit('event', msg as unknown as RtexEvent);
    } else if (typeof msg.reply === 'string') {
      const p = this.pending.shift();
      p?.resolve(msg as unknown as Reply);
    }
  }

  private finish(info: { code: number | null; signal: NodeJS.Signals | null; error?: NodeJS.ErrnoException }): void {
    if (this.exited) return;
    this.exited = true;
    const err = new Error('rtex exited');
    for (const p of this.pending.splice(0)) p.reject(err);
    const exit: ExitInfo = { ...info, stderrTail: [...this.stderrTail], requested: this.stopping };
    this.emit('exit', exit);
  }
}
