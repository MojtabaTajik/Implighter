// Provider registry. Each entry knows how to turn (system, blocks, goal) into a
// request and how to read scores and token usage back out. The rest of the
// extension only ever calls classify(), so adding a provider touches this file
// and the options dropdown, nothing else.

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

// Normalised across providers so the cache figure in the popup means the same
// thing everywhere: how much of the input was served from a cache rather than
// paid for at full rate.
function usageOf({ input = 0, cacheWrite = 0, cacheRead = 0 }) {
  return { input, cacheWrite, cacheRead };
}

async function postJSON(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
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

// --- Anthropic -------------------------------------------------------------
// The only provider with explicit cache breakpoints, so it is the only one where
// the stable-prefix-first ordering is enforced rather than merely hoped for.

async function callAnthropic({ apiKey, model, system, blocksText, goalText }) {
  const data = await postJSON(
    "https://api.anthropic.com/v1/messages",
    {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    {
      model,
      max_tokens: 8000,
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }
      ],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: RESPONSE_SCHEMA }
      },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: blocksText, cache_control: { type: "ephemeral" } },
            { type: "text", text: goalText }
          ]
        }
      ]
    }
  );

  if (data.stop_reason === "refusal") {
    throw new Error("The model declined to score this page.");
  }
  if (data.stop_reason === "max_tokens") {
    throw new Error("Response hit max_tokens mid-chunk. Lower CHUNK_SIZE in content.js.");
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

// --- OpenAI-compatible (OpenAI, Groq) --------------------------------------
// max_tokens is deliberately omitted: OpenAI has moved to max_completion_tokens
// on newer models and rejects the old name, while Groq still wants the old one.
// The output here is a few hundred tokens, so the provider default is fine and
// sidestepping the divergence is worth more than the ceiling.

async function callOpenAICompatible({ url, apiKey, model, system, blocksText, goalText, label }) {
  const data = await postJSON(
    url,
    { authorization: `Bearer ${apiKey}` },
    {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${blocksText}\n\n${goalText}` }
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "implighter_scores", strict: true, schema: RESPONSE_SCHEMA }
      }
    }
  );

  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("Response was truncated mid-chunk. Lower CHUNK_SIZE in content.js.");
  }
  const content = choice?.message?.content;
  if (!content) throw new Error(`Empty response from ${label}.`);

  // Both report prompt_tokens inclusive of any cached portion, so subtract to
  // keep "input" meaning the same thing it does for Anthropic: tokens paid full.
  const cacheRead = data.usage?.prompt_tokens_details?.cached_tokens || 0;
  return {
    scores: parseScores(content, label),
    usage: usageOf({
      input: Math.max(0, (data.usage?.prompt_tokens || 0) - cacheRead),
      cacheRead
    })
  };
}

// --- Registry --------------------------------------------------------------

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    needsKey: true,
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    // Only provider with explicit cache_control, so the only one where the
    // rubric prefix is deliberately cached rather than left to the vendor.
    promptCache: "explicit",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    defaultModel: "claude-opus-5",
    call: (cfg) => callAnthropic(cfg)
  },

  openai: {
    label: "OpenAI",
    needsKey: true,
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    promptCache: "automatic",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
    defaultModel: "gpt-4.1-mini",
    call: (cfg) =>
      callOpenAICompatible({
        ...cfg,
        url: "https://api.openai.com/v1/chat/completions",
        label: "OpenAI"
      })
  },

  groq: {
    label: "Groq",
    needsKey: true,
    keyPlaceholder: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
    promptCache: "none",
    models: [
      "openai/gpt-oss-20b",
      "openai/gpt-oss-120b",
      "llama-3.3-70b-versatile"
    ],
    defaultModel: "openai/gpt-oss-20b",
    call: (cfg) =>
      callOpenAICompatible({
        ...cfg,
        url: "https://api.groq.com/openai/v1/chat/completions",
        label: "Groq"
      })
  },

};

export function providerOf(id) {
  return PROVIDERS[id] || PROVIDERS.anthropic;
}

// A verification call is the real classify path against a two-block fixture with
// an unambiguous answer. That exercises auth, the model id, network reach and
// JSON-schema conformance in one request — the last of which matters most, since
// it is exactly where models differ and where a wrong choice fails silently at
// scoring time rather than at setup time.
export const VERIFY_FIXTURE = {
  goal: "I want to learn how database indexes work",
  blocksText: [
    "[0] <p> A B-tree index stores keys in sorted order, so a lookup walks the tree in O(log n) instead of scanning every row.",
    "[1] <p> (discussion) Great article, thanks for sharing! Subscribe to our newsletter for weekly posts."
  ].join("\n\n")
};
