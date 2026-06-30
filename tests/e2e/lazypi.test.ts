import { test, expect } from '@playwright/test';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execAsync = promisify(exec);

const CLI_PATH = join(__dirname, '../../pi/coding-agent/dist/cli.js');
const TEST_DIR = join(__dirname, '../../tests/fixtures/lazypi-test-workspace');

test.describe('LazyPi: Background Events Extension', () => {
  test.beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  test.afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test('should load background-events extension', async () => {
    // Check that extension files exist and are compiled
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent/dist/extensions')} -name "background-events" -type d`);
    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  test('bg_shell tool should be available in help', async () => {
    // This would require running with API key, but we can check compilation
    const extensionPath = join(__dirname, '../../pi/coding-agent/dist/extensions/background-events');
    const { stdout } = await execAsync(`find ${extensionPath} -name "*.js" -type f`);
    expect(stdout).toContain('background-shell');
  });

  test('sub_agent tool should be compiled', async () => {
    const extensionPath = join(__dirname, '../../pi/coding-agent/dist/extensions/background-events');
    const { stdout } = await execAsync(`find ${extensionPath} -name "*.js" -type f`);
    expect(stdout).toContain('sub-agents');
  });

  test('event-monitor should be compiled', async () => {
    const extensionPath = join(__dirname, '../../pi/coding-agent/dist/extensions/background-events');
    const { stdout } = await execAsync(`find ${extensionPath} -name "*.js" -type f`);
    expect(stdout).toContain('event-monitor');
  });

  test('events-overlay should be compiled', async () => {
    const extensionPath = join(__dirname, '../../pi/coding-agent/dist/extensions/background-events');
    const { stdout } = await execAsync(`find ${extensionPath} -name "*.js" -type f`);
    expect(stdout).toContain('events-overlay');
  });
});

test.describe('LazyPi: Event Naming Convention', () => {
  test('should use "event" terminology in compiled code', async () => {
    const extensionPath = join(__dirname, '../../pi/coding-agent/dist/extensions/background-events');

    // Check that compiled files don't contain "Job" class names
    const { stdout } = await execAsync(`grep -r "BackgroundJob" ${extensionPath} || echo "NONE"`);
    expect(stdout.trim()).toBe('NONE');
  });

  test('should use EventStatus not JobStatus', async () => {
    const extensionPath = join(__dirname, '../../pi/coding-agent/dist/extensions/background-events');

    const { stdout } = await execAsync(`grep -r "JobStatus" ${extensionPath} || echo "NONE"`);
    expect(stdout.trim()).toBe('NONE');
  });

  test('should have createEventsMonitor not createJobsMonitor', async () => {
    const extensionPath = join(__dirname, '../../pi/coding-agent/dist/extensions/background-events');

    const { stdout } = await execAsync(`grep -r "createJobsMonitor" ${extensionPath} || echo "NONE"`);
    expect(stdout.trim()).toBe('NONE');
  });
});

test.describe('LazyPi: Todo Extension', () => {
  test('should compile todo extension', async () => {
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent/dist/extensions')} -name "todo.js" -type f`);
    expect(stdout.trim().length).toBeGreaterThan(0);
  });
});

test.describe('LazyPi: SSH Extension', () => {
  test('should compile ssh extension', async () => {
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent/dist/extensions')} -name "ssh.js" -type f`);
    expect(stdout.trim().length).toBeGreaterThan(0);
  });
});

test.describe('LazyPi: Command Aliases Extension', () => {
  test('should compile command-aliases extension', async () => {
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent/dist/extensions')} -name "command-aliases.js" -type f`);
    expect(stdout.trim().length).toBeGreaterThan(0);
  });
});

test.describe('LazyPi: UI Optimization Extensions', () => {
  test('should compile ui-optimize extension directory', async () => {
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent/dist/extensions')} -name "ui-optimize" -type d`);
    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  test('should include images.js for image token workflow', async () => {
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent/dist/extensions/ui-optimize')} -name "images.js" -type f 2>/dev/null || echo "NONE"`);
    // If ui-optimize is compiled, images should be there
    if (!stdout.includes('NONE')) {
      expect(stdout.trim().length).toBeGreaterThan(0);
    }
  });

  test('should include markdown optimization', async () => {
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent/dist/extensions/ui-optimize')} -name "markdown.js" -type f 2>/dev/null || echo "NONE"`);
    if (!stdout.includes('NONE')) {
      expect(stdout.trim().length).toBeGreaterThan(0);
    }
  });
});

test.describe('LazyPi: Shared Utilities', () => {
  test('should compile shared utilities', async () => {
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent/dist/extensions')} -name "shared" -type d`);
    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  test('should include editor-wrapper utility', async () => {
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent/dist/extensions/shared')} -name "editor-wrapper.js" -type f 2>/dev/null || echo "NONE"`);
    if (!stdout.includes('NONE')) {
      expect(stdout.trim().length).toBeGreaterThan(0);
    }
  });

  test('should include floating-window utility', async () => {
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent/dist/extensions/shared')} -name "floating-window.js" -type f 2>/dev/null || echo "NONE"`);
    if (!stdout.includes('NONE')) {
      expect(stdout.trim().length).toBeGreaterThan(0);
    }
  });

  test('should include shell utilities', async () => {
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent/dist/extensions/shared')} -name "shell.js" -type f 2>/dev/null || echo "NONE"`);
    if (!stdout.includes('NONE')) {
      expect(stdout.trim().length).toBeGreaterThan(0);
    }
  });
});

test.describe('LazyPi: Local Skills', () => {
  test('should have local-skills directory', async () => {
    const { stdout } = await execAsync(`find ${join(__dirname, '../../pi/coding-agent')} -name "local-skills" -type d 2>/dev/null || echo "NONE"`);
    expect(stdout).not.toBe('NONE');
  });

  test('should include paper-analysis skill', async () => {
    const skillPath = join(__dirname, '../../pi/coding-agent/local-skills/paper-analysis');
    const { stdout } = await execAsync(`[ -d "${skillPath}" ] && echo "EXISTS" || echo "NONE"`);
    expect(stdout.trim()).toBe('EXISTS');
  });

  test('should include pptx skill', async () => {
    const skillPath = join(__dirname, '../../pi/coding-agent/local-skills/pptx');
    const { stdout } = await execAsync(`[ -d "${skillPath}" ] && echo "EXISTS" || echo "NONE"`);
    expect(stdout.trim()).toBe('EXISTS');
  });
});

test.describe('LazyPi: Integration Verification', () => {
  test('all LazyPi extensions should be in coding-agent', async () => {
    const extensionsDir = join(__dirname, '../../pi/coding-agent/src/extensions');
    const { stdout } = await execAsync(`ls -1 ${extensionsDir}`);

    expect(stdout).toContain('background-events');
    expect(stdout).toContain('command-aliases.ts');
    expect(stdout).toContain('todo.ts');
    expect(stdout).toContain('ssh.ts');
    expect(stdout).toContain('ui-optimize');
    expect(stdout).toContain('shared');
  });

  test('should not have job-related filenames', async () => {
    const extensionsDir = join(__dirname, '../../pi/coding-agent/src/extensions');
    const { stdout } = await execAsync(`find ${extensionsDir} -name "*job*" -o -name "*Job*"`);

    // Empty output means no job-related files found
    expect(stdout.trim()).toBe('');
  });

  test('should have event-related filenames', async () => {
    const extensionsDir = join(__dirname, '../../pi/coding-agent/src/extensions/background-events');
    const { stdout } = await execAsync(`ls -1 ${extensionsDir} | grep -i event`);

    expect(stdout).toContain('event-monitor');
    expect(stdout).toContain('events-overlay');
  });
});
