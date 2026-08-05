// Provider registry. Each entry exposes two capabilities:
//
//   classify()       strict JSON scores, one request per chunk (highlight)
//   completeStream() free-form markdown, streamed (summarize)
//
// Two adapters cover three providers: Anthropic has its own request shape, while
// OpenAI and Groq share the OpenAI-compatible one.

export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          score: { type: "integer", enum: [0, 1, 2] }
        },
        required: ["id", "score"],
        additionalProperties: false
      }
    }
  },
  required: ["scores"],
  additionalProperties: false
};

// Normalised across providers so a cache figure means the same thing everywhere:
// how much input was served from cache rather than paid for at full rate.
function usageOf({ input = 0, cacheWrite = 0, cacheRead = 0 }) {
  return { input, cacheWrite, cacheRead };
}

async function post(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text.slice(0, 300)}`);
  }
  return response;
}

async function postJSON(url, headers, body) {
  return (await post(url, headers, body)).json();
}

function parseScores(raw, provider) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${provider} returned text that is not JSON: ${String(raw).slice(0, 200)}`);
  }
  if (!Array.isArray(parsed?.scores)) {
    throw new Error(`${provider} returned JSON without a scores array.`);
  }
  return parsed.scores;
}

// --- Server-sent events ------------------------------------------------------
// All three providers stream as SSE, so the transport is shared and only the
// delta shape differs. Frames are separated by a blank line; a frame can span
// reads, so the tail of each read is carried forward rather than parsed early.

async function readSSE(response, onData) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          onData(JSON.parse(payload));
        } catch {
          // A frame that isn't JSON is not fatal — keep consuming the stream.
        }
      }
    }
  }
}

// --- Anthropic ---------------------------------------------------------------
// The only provider with explicit cache breakpoints, so the only one where the
// stable-prefix-first ordering is enforced rather than merely hoped for.

const ANTHROPIC_HEADERS = (apiKey) => ({
  "x-api-key": apiKey,
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true"
});

async function anthropicClassify({ apiKey, model, system, blocksText, goalText }) {
  const data = await postJSON("https://api.anthropic.com/v1/messages", ANTHROPIC_HEADERS(apiKey), {
    model,
    max_tokens: 8000,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
    output_config: { effort: "low", format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: blocksText, cache_control: { type: "ephemeral" } },
          { type: "text", text: goalText }
        ]
      }
    ]
  });

  if (data.stop_reason === "refusal") throw new Error("The model declined to score this page.");
  if (data.stop_reason === "max_tokens") {
    throw new Error("Response hit max_tokens mid-chunk. Lower CHUNK_SIZE in the highlight slice.");
  }

  const textBlock = data.content?.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in the Anthropic response.");

  return {
    scores: parseScores(textBlock.text, "Anthropic"),
    usage: usageOf({
      input: data.usage?.input_tokens,
      cacheWrite: data.usage?.cache_creation_input_tokens,
      cacheRead: data.usage?.cache_read_input_tokens
    })
  };
}

async function anthropicStream({ apiKey, model, system, user, onDelta }) {
  const response = await post("https://api.anthropic.com/v1/messages", ANTHROPIC_HEADERS(apiKey), {
    model,
    max_tokens: 4000,
    stream: true,
    // The instruction prompt is stable across pages, so it caches; the page text
    // that follows is the volatile part.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: user }]
  });

  await readSSE(response, (event) => {
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      onDelta(event.delta.text);
    }
    if (event.type === "error") {
      throw new Error(event.error?.message || "Anthropic stream error");
    }
  });
}

// --- OpenAI-compatible (OpenAI, Groq) ----------------------------------------
// max_tokens is deliberately omitted on the classify path: OpenAI moved to
// max_completion_tokens and rejects the old name on newer models, while Groq
// still expects the old one. Output there is a few hundred tokens, so the
// provider default is fine and sidestepping the divergence is worth more.

async function openAIClassify({ url, apiKey, model, system, blocksText, goalText, label }) {
  const data = await postJSON(url, { authorization: `Bearer ${apiKey}` }, {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `${blocksText}\n\n${goalText}` }
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "implighter_scores", strict: true, schema: RESPONSE_SCHEMA }
    }
  });

  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("Response truncated mid-chunk. Lower CHUNK_SIZE in the highlight slice.");
  }
  const content = choice?.message?.content;
  if (!content) throw new Error(`Empty response from ${label}.`);

  const cacheRead = data.usage?.prompt_tokens_details?.cached_tokens || 0;
  return {
    scores: parseScores(content, label),
    usage: usageOf({
      input: Math.max(0, (data.usage?.prompt_tokens || 0) - cacheRead),
      cacheRead
    })
  };
}

async function openAIStream({ url, apiKey, model, system, user, onDelta }) {
  const response = await post(url, { authorization: `Bearer ${apiKey}` }, {
    model,
    stream: true,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  await readSSE(response, (event) => {
    const delta = event.choices?.[0]?.delta?.content;
    if (delta) onDelta(delta);
  });
}

// --- Registry ----------------------------------------------------------------

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    needsKey: true,
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    promptCache: "explicit",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    defaultModel: "claude-opus-5",
    classify: anthropicClassify,
    completeStream: anthropicStream
  },

  openai: {
    label: "OpenAI",
    needsKey: true,
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    promptCache: "automatic",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
    defaultModel: "gpt-4.1-mini",
    classify: (cfg) =>
      openAIClassify({ ...cfg, url: "https://api.openai.com/v1/chat/completions", label: "OpenAI" }),
    completeStream: (cfg) =>
      openAIStream({ ...cfg, url: "https://api.openai.com/v1/chat/completions" })
  },

  groq: {
    label: "Groq",
    needsKey: true,
    keyPlaceholder: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
    promptCache: "none",
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
    defaultModel: "openai/gpt-oss-20b",
    classify: (cfg) =>
      openAIClassify({
        ...cfg,
        url: "https://api.groq.com/openai/v1/chat/completions",
        label: "Groq"
      }),
    completeStream: (cfg) =>
      openAIStream({ ...cfg, url: "https://api.groq.com/openai/v1/chat/completions" })
  }
};

export function providerOf(id) {
  return PROVIDERS[id] || PROVIDERS.anthropic;
}

// A verification call runs the real classify path against a two-block fixture
// with an unambiguous answer. That exercises auth, model id, network reach and
// JSON-schema conformance in one request — the last mattering most, since it is
// exactly where models differ and where a wrong choice fails silently at scoring
// time rather than at setup time.
export const VERIFY_FIXTURE = {
  goal: "I want to learn how database indexes work",
  blocksText: [
    "[0] <p> A B-tree index stores keys in sorted order, so a lookup walks the tree in O(log n) instead of scanning every row.",
    "[1] <p> (discussion) Great article, thanks for sharing! Subscribe to our newsletter for weekly posts."
  ].join("\n\n")
};
