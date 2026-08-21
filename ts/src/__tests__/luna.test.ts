import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../server.js";
import {
  normalizeModelCatalog,
  publicModelsFromCatalog,
  resolveModelAlias,
} from "../model-catalog.js";
import { ChatGPTOAuthProvider } from "../provider.js";
import { MessageRole } from "../messages.js";

const LUNA_CATALOG = {
  models: [{
    slug: "gpt-5.6-luna",
    display_name: "GPT-5.6 Luna",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "More deliberate" },
      { effort: "xhigh", description: "Maximum analysis" },
      { effort: "max", description: "Highest effort" },
    ],
    context_window: 272000,
    supports_parallel_tool_calls: true,
    use_responses_lite: true,
    supported_in_api: true,
  }],
};

function fakeProvider(
  onChat: (messages: unknown[], options: Record<string, unknown>) => void = () => {},
) {
  return {
    listModels: async () => LUNA_CATALOG,
    async chat(messages: unknown[], options: Record<string, unknown>) {
      onChat(messages, options);
      return {
        content: "ok",
        tool_calls: [],
        finish_reason: "stop",
        usage: null,
        reasoning_content: null,
        raw: null,
        response_id: "response-luna-1",
      };
    },
    chatStream() {
      return (async function* () {
        yield { type: "content", text: "ok" };
        yield { type: "finish", finish_reason: "stop", response_id: "response-luna-1" };
      })();
    },
  };
}

async function withApp(
  provider: Record<string, unknown>,
  fn: (baseUrl: string) => Promise<void>,
  proxyApiKey = "luna-proxy-secret",
): Promise<void> {
  const app = createApp({
    provider: provider as never,
    model: "gpt-5.6-luna",
    proxyApiKey,
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("GPT-5.6 Luna model catalog", () => {
  it("resolves supported effort aliases and leaves unknown suffixes intact", () => {
    const catalog = normalizeModelCatalog(LUNA_CATALOG);
    assert.deepEqual(resolveModelAlias("gpt-5.6-luna-high", catalog), {
      requestedModel: "gpt-5.6-luna-high",
      upstreamModel: "gpt-5.6-luna",
      reasoningEffort: "high",
      catalogEntry: catalog[0],
      alias: true,
    });
    assert.equal(resolveModelAlias("gpt-5.6-luna-max", catalog).reasoningEffort, "max");
    assert.deepEqual(resolveModelAlias("luna-xhigh", catalog), {
      requestedModel: "luna-xhigh",
      upstreamModel: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
      catalogEntry: catalog[0],
      alias: true,
    });
    assert.equal(resolveModelAlias("gpt-5.6-luna", catalog).upstreamModel, "gpt-5.6-luna");
    const unknown = resolveModelAlias("gpt-5.6-luna-low", catalog);
    assert.equal(unknown.upstreamModel, "gpt-5.6-luna-low");
    assert.equal(unknown.reasoningEffort, undefined);
  });

  it("generates only aliases advertised by the authenticated catalog", () => {
    const models = publicModelsFromCatalog(normalizeModelCatalog(LUNA_CATALOG), 123);
    assert.deepEqual(models.map((model) => model.id), [
      "gpt-5.6-luna",
      "gpt-5.6-luna-medium",
      "gpt-5.6-luna-high",
      "gpt-5.6-luna-xhigh",
      "gpt-5.6-luna-max",
      "luna-medium",
      "luna-high",
      "luna-xhigh",
      "luna-max",
    ]);
    assert.equal(models.every((model) => model.created === 123), true);
  });

  it("keeps Cursor system and developer messages distinct in Responses input", () => {
    const provider = new ChatGPTOAuthProvider();
    const payload = (provider as unknown as {
      responsesPayload(messages: { role: MessageRole; content: string }[], options: Record<string, unknown>): Record<string, unknown>;
    }).responsesPayload([
      { role: MessageRole.SYSTEM, content: "You are Cursor." },
      { role: MessageRole.DEVELOPER, content: "Use repository context." },
      { role: MessageRole.USER, content: "Find the bug." },
    ], { model: "gpt-5.6-luna", responsesLite: false });
    assert.equal(payload.instructions, "You are Cursor.");
    assert.deepEqual((payload.input as Record<string, unknown>[]).map((item) => item.role), [
      "developer",
      "user",
    ]);
    assert.equal((payload.input as Record<string, unknown>[])[0].content
      && ((payload.input as Record<string, unknown>[])[0].content as Record<string, unknown>[])[0].text,
    "Use repository context.");
  });
});

describe("Cursor Luna HTTP compatibility", () => {
  it("requires the proxy bearer key before touching the provider", async () => {
    let calls = 0;
    const provider = fakeProvider(() => { calls += 1; });
    await withApp(provider, async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      });
      const wrong = await fetch(`${baseUrl}/v1/models`, {
        headers: { authorization: "Bearer wrong" },
      });
      assert.equal(missing.status, 401);
      assert.equal(wrong.status, 401);
      assert.equal(calls, 0);
    });
  });

  it("exposes dynamic Luna aliases and maps a Cursor alias upstream", async () => {
    let seenMessages: unknown[] = [];
    let seenOptions: Record<string, unknown> = {};
    const provider = fakeProvider((messages, options) => {
      seenMessages = messages;
      seenOptions = options;
    });
    await withApp(provider, async (baseUrl) => {
      const models = await fetch(`${baseUrl}/v1/models`, {
        headers: { authorization: "Bearer luna-proxy-secret" },
      });
      assert.equal(models.status, 200);
      const modelIds = ((await models.json()) as { data: { id: string }[] }).data.map((model) => model.id);
      assert.deepEqual(modelIds, [
        "gpt-5.6-luna",
        "gpt-5.6-luna-medium",
        "gpt-5.6-luna-high",
        "gpt-5.6-luna-xhigh",
        "gpt-5.6-luna-max",
        "luna-medium",
        "luna-high",
        "luna-xhigh",
        "luna-max",
      ]);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer luna-proxy-secret",
        },
        body: JSON.stringify({
          model: "luna-xhigh",
          messages: [
            { role: "system", content: "You are Cursor." },
            { role: "developer", content: "Preserve this developer instruction." },
            { role: "user", content: "Inspect the repository." },
          ],
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(seenOptions.model, "gpt-5.6-luna");
      assert.deepEqual(seenOptions.reasoning, { effort: "xhigh" });
      assert.deepEqual((seenMessages as { role: string; content: string }[]).map((message) => [message.role, message.content]), [
        ["system", "You are Cursor."],
        ["developer", "Preserve this developer instruction."],
        ["user", "Inspect the repository."],
      ]);
    });
  });

  it("translates streamed function arguments without buffering the response", async () => {
    const provider = fakeProvider();
    (provider as { chatStream: () => AsyncGenerator<Record<string, unknown>> }).chatStream = () => (async function* () {
      yield { type: "tool_call_start", id: "call-1", name: "read_file", arguments: "" };
      yield { type: "tool_call_delta", id: "call-1", arguments: '{"path":"' };
      yield { type: "tool_call_delta", id: "call-1", arguments: 'README.md"}' };
      yield { type: "finish", finish_reason: "tool_calls", response_id: "response-tool-1" };
    })();

    await withApp(provider, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer luna-proxy-secret",
        },
        body: JSON.stringify({
          stream: true,
          model: "gpt-5.6-luna-high",
          messages: [{ role: "user", content: "Read README.md" }],
        }),
      });
      const chunks = (await response.text())
        .split("\n\n")
        .filter((block) => block.startsWith("data: {"))
        .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
      const argumentsText = chunks.flatMap((chunk) => {
        const choices = chunk.choices;
        if (!Array.isArray(choices) || choices.length === 0) return [];
        const delta = (choices[0] as Record<string, unknown>).delta;
        if (typeof delta !== "object" || delta === null) return [];
        const calls = (delta as Record<string, unknown>).tool_calls;
        if (!Array.isArray(calls)) return [];
        return calls.map((call) => {
          const functionData = (call as Record<string, unknown>).function;
          return typeof functionData === "object" && functionData !== null
            ? String((functionData as Record<string, unknown>).arguments ?? "")
            : "";
        });
      }).join("");
      assert.equal(argumentsText, '{"path":"README.md"}');
      assert.match(await (await fetch(`${baseUrl}/health`)).text(), /"status":"ok"/);
    });
  });
});

describe("Responses function-call event translation", () => {
  it("emits streamed argument deltas and preserves the final call in history", async () => {
    const provider = new ChatGPTOAuthProvider();
    (provider as unknown as {
      postSSE(): AsyncGenerator<Record<string, unknown>>;
    }).postSSE = async function* () {
      yield {
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call-1", name: "grep", arguments: "" },
      };
      yield { type: "response.function_call_arguments.delta", item_id: "call-1", delta: '{"q":"' };
      yield { type: "response.function_call_arguments.delta", item_id: "call-1", delta: 'Luna"}' };
      yield {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call-1",
          name: "grep",
          arguments: '{"q":"Luna"}',
        },
      };
      yield { type: "response.completed", response: { id: "response-tool-2", output: [] } };
    };
    const events: Record<string, unknown>[] = [];
    for await (const event of provider.chatStream([
      { role: MessageRole.SYSTEM, content: "You are Cursor." },
      { role: MessageRole.USER, content: "Find Luna." },
    ], { model: "gpt-5.6-luna", responsesLite: false })) {
      events.push(event);
    }
    assert.deepEqual(events.map((event) => event.type), [
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "finish",
    ]);
    assert.equal(events[1].id, "call-1");
    assert.equal(events[2].arguments, 'Luna"}');
  });

  it("replays Luna reasoning and function-call items on the next turn", async () => {
    const provider = new ChatGPTOAuthProvider();
    const payloads: Record<string, unknown>[] = [];
    (provider as unknown as {
      postSSE(path: string, payload: Record<string, unknown>): AsyncGenerator<Record<string, unknown>>;
    }).postSSE = async function* (_path, payload) {
      payloads.push(payload);
      if (payloads.length === 1) {
        const functionCall = {
          type: "function_call",
          call_id: "call-luna-1",
          name: "read_file",
          arguments: '{"path":"README.md"}',
        };
        yield {
          type: "response.output_item.done",
          item: { type: "reasoning", id: "reasoning-luna-1", encrypted_content: "opaque" },
        };
        yield { type: "response.output_item.done", item: functionCall };
        yield { type: "response.completed", response: { id: "response-luna-1", output: [] } };
        return;
      }
      yield {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "continued" }],
        },
      };
      yield { type: "response.completed", response: { id: "response-luna-2", output: [] } };
    };

    const first = await provider.chat([
      { role: MessageRole.SYSTEM, content: "You are Cursor." },
      { role: MessageRole.USER, content: "Read README.md" },
    ], { model: "gpt-5.6-luna", responsesLite: false });
    assert.equal(first.response_id, "response-luna-1");
    await provider.chat([
      { role: MessageRole.SYSTEM, content: "You are Cursor." },
      { role: MessageRole.TOOL, content: "contents", tool_call_id: "call-luna-1", name: "read_file" },
    ], { model: "gpt-5.6-luna", responsesLite: false, previousResponseId: first.response_id });
    const continuationInput = payloads[1].input as Record<string, unknown>[];
    assert.equal(Object.hasOwn(payloads[1], "previous_response_id"), false);
    assert.equal(continuationInput.some((item) => item.type === "reasoning"), true);
    assert.equal(continuationInput.some((item) => item.type === "function_call"), true);
    assert.equal(continuationInput.at(-1)?.type, "function_call_output");
  });
});
