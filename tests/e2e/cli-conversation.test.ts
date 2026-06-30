import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLI_PATH = join(__dirname, '../../pi/coding-agent/dist/cli.js');
const TEST_DIR = join(__dirname, '../../tests/fixtures/e2e-conversation');

/**
 * Helper to run CLI command and capture output.
 * Uses spawn's cwd option to set the working directory (no --cwd flag exists).
 */
async function runCLI(
  args: string[],
  options: { input?: string; timeout?: number; cwd?: string } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { input, timeout = 45000, cwd = TEST_DIR } = options;
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI_PATH, ...args], {
      env: process.env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    if (input) {
      proc.stdin.write(input);
    }
    // Always close stdin so print mode's readPipedStdin() sees EOF and proceeds.
    // Without this, the CLI waits forever for stdin to close and the test times out.
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`CLI command timed out after ${timeout}ms`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test.describe('E2E: CLI Real Conversation Tests', () => {
  test.beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test('should respond to a simple prompt using external auth', async () => {
    const { stdout, stderr, exitCode } = await runCLI([
      '--print', '--no-session',
      'What is 2+2? Reply with just the number.'
    ]);

    expect(stderr).not.toContain('No API key found');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/4/);
  });

  test('should read and analyze a file via the read tool', async () => {
    await writeFile(join(TEST_DIR, 'sample.txt'), 'The quick brown fox jumps over the lazy dog.');

    const { stdout, stderr, exitCode } = await runCLI([
      '--print', '--no-session',
      'Read sample.txt and count how many words are in it. Reply with just the number.'
    ]);

    expect(stderr).not.toContain('No API key found');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/9/);
  });

  test('should execute bash commands via the bash tool', async () => {
    const { stdout, stderr, exitCode } = await runCLI([
      '--print', '--no-session',
      'Use bash to echo the text "hello world" and tell me what the output was.'
    ]);

    expect(stderr).not.toContain('No API key found');
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain('hello');
  });

  test('should create a file via the write tool', async () => {
    const { stderr, exitCode } = await runCLI([
      '--print', '--no-session',
      'Create a file called test-output.txt containing exactly the text: Testing 123'
    ]);

    expect(stderr).not.toContain('No API key found');
    expect(exitCode).toBe(0);

    const content = await readFile(join(TEST_DIR, 'test-output.txt'), 'utf-8');
    expect(content).toContain('Testing 123');
  });

  test('should support JSON output mode', async () => {
    const { stdout, stderr, exitCode } = await runCLI([
      '--print', '--mode', 'json', '--no-session',
      'What is 1+1? Reply with just the number.'
    ]);

    expect(stderr).not.toContain('No API key found');
    expect(exitCode).toBe(0);
    // JSON mode emits at least one valid JSON object (may be JSONL)
    const firstLine = stdout.trim().split('\n')[0];
    expect(() => JSON.parse(firstLine)).not.toThrow();
  });

  test('should handle file attachments with @ syntax', async () => {
    await writeFile(join(TEST_DIR, 'data.txt'), 'Important data: XYZ123');

    const { stdout, stderr, exitCode } = await runCLI([
      '--print', '--no-session',
      '@data.txt',
      'What is the important data code in this file? Reply with just the code.'
    ]);

    expect(stderr).not.toContain('No API key found');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('XYZ123');
  });

  test('should respect a custom --system-prompt', async () => {
    const { stdout, stderr, exitCode } = await runCLI([
      '--print', '--no-session',
      '--system-prompt', 'You always end every reply with the exact word BANANA.',
      'Say hello.'
    ]);

    expect(stderr).not.toContain('No API key found');
    expect(exitCode).toBe(0);
    expect(stdout.toUpperCase()).toContain('BANANA');
  });
});
