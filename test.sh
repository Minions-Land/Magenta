#!/usr/bin/env bash
set -euo pipefail

# Isolate every home-directory credential source, including Magenta, Claude
# Code, Codex, AWS profiles, and other provider CLIs.
TMP_ROOT="${TMPDIR:-/tmp}"
TEST_HOME="$(mktemp -d "${TMP_ROOT%/}/magenta-no-auth.XXXXXX")"
cleanup() {
    rm -rf "$TEST_HOME"
}
trap cleanup EXIT
export HOME="$TEST_HOME"
export npm_config_update_notifier=false

# Skip local LLM tests (ollama, lmstudio)
export PI_NO_LOCAL_LLM=1

# Unset API keys (see pi/ai/src/env-api-keys.ts and provider factories).
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_OAUTH_TOKEN
unset ANT_LING_API_KEY
unset NVIDIA_API_KEY
unset OPENAI_API_KEY
unset AZURE_OPENAI_API_KEY
unset DEEPSEEK_API_KEY
unset GEMINI_API_KEY
unset GOOGLE_API_KEY
unset GOOGLE_CLOUD_API_KEY
unset GROQ_API_KEY
unset CEREBRAS_API_KEY
unset XAI_API_KEY
unset OPENROUTER_API_KEY
unset ZAI_API_KEY
unset ZAI_CODING_CN_API_KEY
unset MISTRAL_API_KEY
unset MINIMAX_API_KEY
unset MINIMAX_CN_API_KEY
unset MOONSHOT_API_KEY
unset KIMI_API_KEY
unset HF_TOKEN
unset FIREWORKS_API_KEY
unset TOGETHER_API_KEY
unset AI_GATEWAY_API_KEY
unset OPENCODE_API_KEY
unset CLOUDFLARE_API_KEY
unset CLOUDFLARE_ACCOUNT_ID
unset CLOUDFLARE_GATEWAY_ID
unset XIAOMI_API_KEY
unset XIAOMI_TOKEN_PLAN_CN_API_KEY
unset XIAOMI_TOKEN_PLAN_AMS_API_KEY
unset XIAOMI_TOKEN_PLAN_SGP_API_KEY
unset COPILOT_GITHUB_TOKEN
unset GH_TOKEN
unset GITHUB_TOKEN
unset GIT_ASKPASS
unset SSH_ASKPASS
unset SSH_AUTH_SOCK
unset HF_HOME
unset HUGGINGFACE_HUB_TOKEN
unset NPM_TOKEN
unset NODE_AUTH_TOKEN
unset GOOGLE_APPLICATION_CREDENTIALS
unset GOOGLE_CLOUD_PROJECT
unset GCLOUD_PROJECT
unset GOOGLE_CLOUD_LOCATION
unset AWS_PROFILE
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
unset AWS_REGION
unset AWS_DEFAULT_REGION
unset AWS_BEARER_TOKEN_BEDROCK
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
unset AWS_CONTAINER_CREDENTIALS_FULL_URI
unset AWS_WEB_IDENTITY_TOKEN_FILE
unset BEDROCK_EXTENSIVE_MODEL_TEST
export GIT_TERMINAL_PROMPT=0

echo "Running tests with an isolated HOME and no provider API keys..."
npm test
