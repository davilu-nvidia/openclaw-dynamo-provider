// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import {
	DYNAMO_PROVIDER_ID,
	DEFAULT_DYNAMO_MODEL_ID,
	applySubagentBridge,
	readDynamoConfig,
} from "./config.js";
import {
	buildDynamoAgentContext,
	buildDynamoHeaders,
	discoverDynamoModels,
	DynamoSubagentSession,
	mergeDynamoAgentContext,
	mergeDynamoSessionControl,
} from "./dynamo-provider.js";
import {
	DynamoToolEventPublisher,
	DynamoToolEventRelay,
	readDynamoToolRelayConfig,
} from "./tool-relay.js";

export default definePluginEntry({
	id: "dynamo",
	name: "Dynamo Provider",
	description: "Dynamo OpenAI-compatible provider with agent-context tracing and KV session isolation.",

	register(api) {
		applySubagentBridge();
		const config = readDynamoConfig();

		// Subagent KV session (only for child agents)
		const session =
			config.traceEnabled && config.sessionControlId
				? new DynamoSubagentSession({
						baseUrl: config.baseUrl,
						apiKey: config.apiKey,
						sessionControlId: config.sessionControlId,
						...(config.sessionTimeoutSecs !== undefined ? { sessionTimeoutSecs: config.sessionTimeoutSecs } : {}),
					})
				: undefined;

		// --- 1. Register provider ---
		api.registerProvider({
			id: DYNAMO_PROVIDER_ID,
			label: "Dynamo",
			docsPath: "/providers/dynamo",
			envVars: ["DYNAMO_API_KEY"],

			auth: [
				createProviderApiKeyAuthMethod({
					providerId: DYNAMO_PROVIDER_ID,
					methodId: "api-key",
					label: "Dynamo API key",
					hint: "API key for Dynamo (local Dynamo usually ignores this)",
					optionKey: "dynamoApiKey",
					flagName: "--dynamo-api-key",
					envVar: "DYNAMO_API_KEY",
					promptMessage: "Enter your Dynamo API key",
					defaultModel: `${DYNAMO_PROVIDER_ID}/${DEFAULT_DYNAMO_MODEL_ID}`,
				}),
			],

			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(DYNAMO_PROVIDER_ID).apiKey ?? config.apiKey;
					const discovered = await discoverDynamoModels({ ...config, apiKey });
					const models =
						discovered.length > 0
							? discovered.map((m) => ({
									id: m.id,
									name: m.name,
									reasoning: false,
									input: ["text" as const],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 128000,
									maxTokens: 8192,
								}))
							: [
									{
										id: DEFAULT_DYNAMO_MODEL_ID,
										name: "Dynamo Default",
										reasoning: false,
										input: ["text" as const],
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
										contextWindow: 128000,
										maxTokens: 8192,
									},
								];

					return {
						provider: {
							baseUrl: config.baseUrl,
							apiKey,
							api: "openai-completions",
							models,
						},
					};
				},
			},

			// Accept arbitrary dynamo/<model-id>
			resolveDynamicModel: (ctx) => ({
				id: ctx.modelId,
				name: ctx.modelId,
				provider: DYNAMO_PROVIDER_ID,
				api: "openai-completions",
				baseUrl: config.baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			}),

			// Inject x-request-id header per turn
			resolveTransportTurnState: (ctx) => ({
				headers: buildDynamoHeaders(undefined),
			}),

			// Inject nvext.agent_context and session_control into request body
			wrapStreamFn: (ctx) => {
				if (!ctx.streamFn) return undefined;
				const inner = ctx.streamFn;

				return async (params) => {
					// Always add x-request-id
					params.headers = buildDynamoHeaders(params.headers);

					// DYN_AGENT_TRACE off: plain provider, no agentic nvext
					if (!config.traceEnabled) {
						return inner(params);
					}

					// Build and inject agent_context
					const agentContext = buildDynamoAgentContext(config, ctx.sessionId);
					if (params.body) {
						params.body = mergeDynamoAgentContext(params.body, agentContext);
					}

					// Subagent KV session control
					if (session) {
						session.modelId = ctx.model?.id ?? "";
						const sessionControl = session.controlForTurn();
						if (params.body) {
							params.body = mergeDynamoSessionControl(params.body, sessionControl);
						}
					}

					return inner(params);
				};
			},
		});

		// --- 2. Model catalog for list/picker UI ---
		api.registerModelCatalogProvider({
			provider: DYNAMO_PROVIDER_ID,
			kinds: ["text"],
			liveCatalog: async (ctx) => {
				const apiKey = ctx.resolveProviderApiKey(DYNAMO_PROVIDER_ID).apiKey ?? config.apiKey;
				const discovered = await discoverDynamoModels({ ...config, apiKey });
				if (discovered.length === 0) return null;
				return discovered.map((m) => ({
					kind: "text" as const,
					provider: DYNAMO_PROVIDER_ID,
					model: m.id,
					label: m.name,
					source: "live" as const,
				}));
			},
		});

		// --- 3. Session lifecycle: KV isolation ---
		if (session) {
			api.on("agent_end", async () => {
				await session.close();
			});
			api.on("session_end", async () => {
				await session.close();
			});
		}

		// --- 4. Tool event relay ---
		if (config.traceEnabled) {
			const relayConfig = readDynamoToolRelayConfig();
			if (relayConfig.endpoint) {
				const publisher = new DynamoToolEventPublisher(relayConfig);
				publisher.start().catch(() => {});
				const relay = new DynamoToolEventRelay(config, publisher, config.sessionId);

				api.on("tool_execution_start", (event) => {
					relay.handleToolExecutionStart({
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
					});
				});
				api.on("tool_execution_end", (event) => {
					relay.handleToolExecutionEnd({
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result,
						isError: event.isError,
					});
				});
				api.on("session_end", () => {
					publisher.close();
				});
			}
		}
	},
});

export * from "./config.js";
export * from "./dynamo-provider.js";
export * from "./tool-relay.js";
