/**
 * API Keys and OAuth
 *
 * Configure credential and model resolution via ModelRuntime and ModelRegistry.
 */

import {
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// Default: ModelRuntime owns credentials and loads built-in + custom models.
const modelRuntime = await ModelRuntime.create();
const modelRegistry = new ModelRegistry(modelRuntime);

const { session: defaultAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime,
	modelRegistry,
});
console.log("Session with default auth storage and model registry");
await defaultAuthSession.dispose();

// Custom auth storage location
const customAuthStorage = AuthStorage.create("/tmp/my-app/auth.json");
const customModelRuntime = await ModelRuntime.create({
	authPath: "/tmp/my-app/auth.json",
	modelsPath: "/tmp/my-app/models.json",
});
const customModelRegistry = new ModelRegistry(customModelRuntime);

const { session: customAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage: customAuthStorage,
	modelRuntime: customModelRuntime,
	modelRegistry: customModelRegistry,
});
console.log("Session with custom auth storage location");
await customAuthSession.dispose();

// Runtime API key override (not persisted to disk)
await modelRuntime.setRuntimeApiKey("anthropic", "sk-my-temp-key");
const { session: runtimeKeySession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime,
	modelRegistry,
});
console.log("Session with runtime API key override");
await runtimeKeySession.dispose();

// No models.json - only built-in models
const simpleRuntime = await ModelRuntime.create({ modelsPath: null });
const simpleRegistry = new ModelRegistry(simpleRuntime);
const { session: builtInModelsSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime: simpleRuntime,
	modelRegistry: simpleRegistry,
});
console.log("Session with only built-in models");
await builtInModelsSession.dispose();
