import { test, expect } from '@playwright/test';
import * as pty from 'node-pty';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, rm, readFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLI_PATH = join(__dirname, '../../pi/coding-agent/dist/cli.js');
const TEST_DIR = join(__dirname, '../../tests/fixtures/tui-test-workspace');

// Strip ANSI escape codes so assertions match on visible text.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * Drives the interactive TUI inside a real pseudo-terminal via node-pty.
 * A PTY is required because the TUI refuses to start unless stdout.isTTY is true.
 */
class TUISession {
  private proc: pty.IPty | null = null;
  private output = '';

  start(args: string[] = [], cwd: string = TEST_DIR): void {
    this.proc = pty.spawn('node', [CLI_PATH, ...args], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: process.env as { [key: string]: string },
    });
    this.proc.onData((data) => {
      this.output += data;
    });
  }

  /** Type text into the TUI (no Enter). */
  type(text: string): void {
    this.proc?.write(text);
  }

  /** Submit the current input line. */
  enter(): void {
    this.proc?.write('\r');
  }

  getOutput(): string {
    return stripAnsi(this.output);
  }

  getRawOutput(): string {
    return this.output;
  }

  /** Wait until predicate(output) is true or timeout elapses. */
  async waitFor(predicate: (out: string) => boolean, timeoutMs = 20000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate(this.getOutput())) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async wait(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  stop(): void {
    try {
      this.proc?.kill();
    } catch {
      // already exited
    }
    this.proc = null;
  }
}

test.describe('TUI Interactive Mode (real PTY)', () => {
  let tui: TUISession;

  test.beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    tui = new TUISession();
  });

  test.afterEach(async () => {
    tui.stop();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test('should boot the TUI and render the input prompt', async () => {
    tui.start(['--no-session']);
    // The TUI should render its chrome (border / prompt) within a few seconds.
    const ready = await tui.waitFor((out) => out.length > 0, 10000);
    expect(ready).toBe(true);
    // Should not show the "no API key" error since external auth is configured.
    expect(tui.getOutput()).not.toContain('No API key found');
  });

  test('should hold a real conversation and render the assistant reply', async () => {
    tui.start(['--no-session']);
    await tui.waitFor((out) => out.length > 0, 10000);

    tui.type('What is 7 plus 6? Reply with just the number.');
    await tui.wait(500);
    tui.enter();

    // Wait for the model to stream back the answer (13).
    const gotAnswer = await tui.waitFor((out) => /13/.test(out), 40000);
    expect(gotAnswer).toBe(true);
  });

  test('should run the /session slash command', async () => {
    tui.start(['--no-session']);
    await tui.waitFor((out) => out.length > 0, 10000);

    tui.type('/session');
    await tui.wait(500);
    tui.enter();

    // /session renders a stable, command-specific information panel.
    const shown = await tui.waitFor(
      (out) => out.includes('Session Info') && out.includes('Messages') && out.includes('Tokens'),
      15000
    );
    expect(shown).toBe(true);
  });

  test('should use a tool in interactive mode (create a file)', async () => {
    tui.start(['--no-session']);
    await tui.waitFor((out) => out.length > 0, 10000);

    tui.type('Create a file named tui-created.txt with the content HELLO_TUI');
    await tui.wait(500);
    tui.enter();

    // Wait for the model to finish; then verify the file landed on disk.
    const created = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 45000) {
        try {
          const content = await readFile(join(TEST_DIR, 'tui-created.txt'), 'utf-8');
          if (content.includes('HELLO_TUI')) return true;
        } catch {
          // not yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    })();

    expect(created).toBe(true);
  });
});
