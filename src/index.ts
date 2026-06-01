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
	buildDynamoAgentHints,
	buildDynamoHeaders,
	discoverDynamoModels,
	DynamoSubagentSession,
	mergeDynamoNvext,
} from "./dynamo-provider.js";
import { OslPredictor } from "./osl-predictor.js";
import {
	DynamoToolEventPublisher,
	DynamoToolEventRelay,
	readDynamoToolRelayConfig,
} from "./tool-relay.js";

export default definePluginEntry({
	id: "dynamo",
	name: "Dynamo Provider",
	description: "Dynamo OpenAI-compatible provider with agent hints, context tracing, and KV session isolation.",

	register(api) {
		applySubagentBridge();
		const config = readDynamoConfig();

		// OSL predictor: online, per-session, adapts to workload
		const oslPredictor = config.traceEnabled ? new OslPredictor() : undefined;

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

			resolveTransportTurnState: () => ({
				headers: buildDynamoHeaders(undefined),
			}),

			wrapStreamFn: (ctx) => {
				if (!ctx.streamFn) return undefined;
				const inner = ctx.streamFn;

				return async (params) => {
					params.headers = buildDynamoHeaders(params.headers);

					if (!config.traceEnabled) {
						return inner(params);
					}

					const agentContext = buildDynamoAgentContext(config, ctx.sessionId);

					// Use OSL predictor for agent_hints.osl (falls back to config.osl)
					const predictedOsl = oslPredictor?.predict();
					const agentHints = buildDynamoAgentHints(config, predictedOsl);

					let sessionControl = undefined;
					if (session) {
						session.modelId = ctx.model?.id ?? "";
						sessionControl = session.controlForTurn();
					}

					if (params.body) {
						params.body = mergeDynamoNvext(params.body, agentContext, agentHints, sessionControl);
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

		// --- 3. Session lifecycle: KV isolation + OSL predictor reset ---
		if (session) {
			api.on("agent_end", async () => {
				await session.close();
			});
			api.on("session_end", async () => {
				await session.close();
				oslPredictor?.reset();
			});
		} else if (oslPredictor) {
			api.on("session_end", () => {
				oslPredictor.reset();
			});
		}

		// --- 4. OSL predictor feedback: update with actual output tokens ---
		// The predictor learns from observed outputs. We hook into the usage
		// reported after each LLM turn. OpenClaw emits this as part of the
		// message stream; we observe it via the tool_execution_end event where
		// output_tokens is available in the result metadata.
		if (oslPredictor) {
			api.on("message_complete", (event) => {
				const outputTokens = event?.usage?.output_tokens ?? event?.usage?.completion_tokens;
				if (typeof outputTokens === "number" && outputTokens >= 0) {
					oslPredictor.update(outputTokens);
				}
			});
		}

		// --- 5. Tool event relay ---
		if (config.traceEnabled) {
			const relayConfig = readDynamoToolRelayConfig();
			if (relayConfig.endpoint) {
				const publisher = new DynamoToolEventPublisher(relayConfig);
				publisher.start().catch(() => {});
				const relay = new DynamoToolEventRelay(config, publisher, config.workflowId);

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
export * from "./osl-predictor.js";
export * from "./tool-relay.js";
