# Magenta3

AI coding assistant combining the Pi framework with Harness-backed reusable tools.

## Status

✅ **Integration Complete** - All packages built, all tests passing  
✅ **External Auth Support** - Auto-detects Claude Code & Codex credentials

## Quick Start

### Setup API Key

Choose one method:

```bash
# Method 1: Environment variable
export ANTHROPIC_API_KEY=sk-ant-xxx
./bin/magenta

# Method 2: Interactive login
./bin/magenta
/login

# Method 3: Command-line parameter
./bin/magenta --api-key sk-ant-xxx --provider anthropic

# Method 4: Auto-detect from Claude Code/Codex (if installed)
./bin/magenta  # Automatically uses external credentials
```

See [AUTHENTICATION.md](./AUTHENTICATION.md) for detailed setup instructions.

### Basic Usage

```bash
# Check version
./bin/magenta --version

# Run interactive mode
./bin/magenta

# Run tests
npx playwright test --project=lazypi-tests
```

## Project Structure

```
Magenta3/
├── pi/                    # Pi ecosystem
│   ├── ai/                # LLM API abstraction
│   ├── agent/             # Agent core
│   ├── coding-agent/      # Full app + Pi UX/session features
│   └── tui/               # Terminal UI
├── harness/               # Agent runtime + pure execution components
│   └── memory/            # Semantic memory package
├── tests/                 # E2E test suite
└── bin/magenta            # CLI entry point
```

## Pi UX And Tools

Former bundled Pi extension behavior has been moved to the layer that owns it:

### Pi Core/TUI
- **bg_shell** - Long-running shell commands
- **sub_agent** - Parallel agent delegation
- **/events** - Event monitoring UI
- **/side**, **/btw**, **/s** - No-tools side chat
- **command aliases** - Bare `exit`, `quit`, and `clear`
- **UI polish** - Image tokens, Markdown rendering, and tool activity grouping

### Harness Tools
- **todo** - TODO management via `harness/tools/todo/`

### Stable Optional Extension
- **ssh** - Opt-in SSH integration in `harness/extensions/pi/bundled/ssh.ts`

### Harness Skills
- **paper-analysis** - Academic paper processing
- **pptx** - PowerPoint generation

## Key Changes

### Job → Event Terminology
All "job" terminology renamed to "event" for consistency:
- `BackgroundJob` → `BackgroundEvent`
- `JobStatus` → `EventStatus`
- `/jobs` → `/events`
- `job-monitor.ts` → `event-monitor.ts`

### Build System
- TypeScript 5.7+ with `erasableSyntaxOnly`
- All readonly parameters converted to properties
- ES module compliance

## Testing

**24/24 LazyPi integration tests passing** ✅

```bash
# Run all tests
npx playwright test

# Run specific test suites
npx playwright test --project=cli-tests
npx playwright test --project=tui-tests
npx playwright test --project=lazypi-tests
```

## Build

```bash
# Build all packages
npm run build

# Build specific package
npm run build -w @earendil-works/pi-coding-agent

# Clean and rebuild
npm run clean && npm run build
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -w @earendil-works/pi-coding-agent
```

## Documentation

- [TEST_REPORT.md](./TEST_REPORT.md) - Detailed integration report
- [pi/coding-agent/](./pi/coding-agent/) - Main application code
- [tests/e2e/](./tests/e2e/) - E2E test suite

## Architecture

### Pi Packages
| Package | Description | Files |
|---------|-------------|-------|
| pi/ai | LLM API abstraction | 145 |
| pi/agent | Agent core | 6 |
| pi/coding-agent | Full application | 182 |
| harness/memory | Memory system | 5 |
| pi/tui | Terminal UI | 28 |
| harness | Runtime environment | 20 |

### Extension System
Extensions are TypeScript modules in `pi/coding-agent/src/extensions/`:
- Load at application startup
- Can add tools, commands, UI components
- Access full Pi API

## License

See individual package LICENSE files.

## Contributing

This is an integration of Pi and LazyPi. For upstream contributions:
- Pi issues → [pi repository]
- LazyPi extensions → [lazypi repository]
