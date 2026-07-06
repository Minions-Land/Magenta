# External Authentication Setup

Magenta3 can automatically load API keys from multiple sources.

## Auto-Detection Priority

Magenta checks for credentials in this order:

1. **Magenta's own auth.json** (`~/.magenta/agent/auth.json`)
2. **External tools** (Claude Code, Codex)
3. **Environment variables**

## Setup Methods

### Method 1: Interactive Login (Recommended)

Start Magenta and use the `/login` command:

```bash
./bin/magenta
/login
```

Select your provider and enter credentials. They'll be stored in `~/.magenta/agent/auth.json`.

### Method 2: Environment Variables

Set the appropriate environment variable:

```bash
# Anthropic Claude
export ANTHROPIC_API_KEY=sk-ant-xxx

# OpenAI
export OPENAI_API_KEY=sk-xxx

# Google Gemini
export GEMINI_API_KEY=xxx

# Then start Magenta
./bin/magenta
```

### Method 3: Command-Line Parameter

Pass the API key directly:

```bash
./bin/magenta --api-key sk-ant-xxx --provider anthropic
```

### Method 4: External Tool Integration

If you have Claude Code or OpenAI Codex installed, Magenta will automatically detect their credentials:

**Claude Code:** `~/.claude/auth.json`
**Codex:** `~/.openai/auth.json`

No additional setup needed - just install those tools and Magenta will use their credentials.

## Supported Providers

Magenta supports 28+ providers including:

- **Anthropic** (Claude) - `ANTHROPIC_API_KEY`
- **OpenAI** (GPT) - `OPENAI_API_KEY`
- **Google** (Gemini) - `GEMINI_API_KEY`
- **DeepSeek** - `DEEPSEEK_API_KEY`
- **Groq** - `GROQ_API_KEY`
- **xAI** (Grok) - `XAI_API_KEY`
- **OpenRouter** - `OPENROUTER_API_KEY`
- And many more...

See `pi/coding-agent/docs/providers.md` for the complete list.

## Verifying Setup

Check if credentials are found:

```bash
# This should not show "No API key found"
./bin/magenta --version
./bin/magenta --print --no-session "echo hello"
```

If you see "No API key found", credentials are not configured yet.

## Security Notes

- All auth files are stored with `0600` permissions (read/write for owner only)
- Credentials are never logged or displayed in output
- External auth files are read-only (Magenta never modifies them)
- OAuth tokens are automatically refreshed when expired

## Troubleshooting

**"No API key found"**
- Check that at least one of the setup methods is configured
- Verify the provider name matches (e.g., `anthropic`, not `claude`)
- Check file permissions on `~/.magenta/agent/auth.json`

**External credentials not detected**
- Ensure the external tool's auth file exists and contains valid JSON
- Check file paths: `~/.claude/auth.json` or `~/.openai/auth.json`
- The file must have a structure like `{"provider": {"type": "api_key", "key": "..."}}`

**OAuth tokens expired**
- Run `/login` again to refresh
- Or use an API key directly instead of OAuth
