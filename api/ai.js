/**
 * Iron Ledger — AI Coach endpoint (multi-model with automatic fallback)
 *
 * Models (all free tier):
 *   1. Gemini 3.6 Flash   — primary, supports vision  (GEMINI_API_KEY)
 *   2. Groq Llama 3.3 70B — text-only fallback        (GROQ_API_KEY)
 *   3. Gemini 2.5 Flash   — secondary vision fallback  (same GEMINI_API_KEY)
 *
 * On 429/5xx the handler automatically tries the next model.
 * Vision tasks (lab image) skip non-vision models.
 *
 * Setup: add GEMINI_API_KEY (required) and optionally GROQ_API_KEY to Vercel env vars.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';

/* ---- model registry (order = priority) ---- */
const ALL_MODELS = [
  { id: 'gemini-flash', provider: 'gemini', model: 'gemini-3.6-flash', key: GEMINI_KEY, vision: true },
  { id: 'groq-llama', provider: 'openai', model: 'llama-3.3-70b-versatile', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_KEY, vision: false },
];
const MODELS = ALL_MODELS.filter(m => m.key);

/* ---- JSON extraction ---- */
function strip(raw) {
  const s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let result = null;
  try { result = JSON.parse(s); } catch (_) {}
  if (!result) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) try { result = JSON.parse(m[0]); } catch (_) {}
  }
  return result;
}

/* ---- Gemini API caller ---- */
const SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
];

async function callGeminiModel(model, contents, { temperature = 0.7, maxOutputTokens = 2048 } = {}) {
  const url = `${GEMINI_BASE}/${model.model}:generateContent?key=${model.key}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature, maxOutputTokens },
      safetySettings: SAFETY,
    }),
  });
}

/* ---- OpenAI-compatible API caller (Groq, etc.) ---- */
function geminiContentsToOpenAI(contents) {
  const msgs = [];
  for (const c of contents) {
    const text = c.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
    if (!text) continue;
    const role = c.role === 'model' ? 'assistant' : c.role === 'user' ? 'user' : 'user';
    // First user message contains the system prompt — split it out
    if (msgs.length === 0 && role === 'user') {
      msgs.push({ role: 'system', content: text });
    } else {
      msgs.push({ role, content: text });
    }
  }
  // OpenAI needs at least one user message after system
  if (msgs.length === 1 && msgs[0].role === 'system') {
    msgs.push({ role: 'user', content: 'Begin.' });
  }
  return msgs;
}

async function callOpenAIModel(model, contents, { temperature = 0.7, maxOutputTokens = 2048 } = {}) {
  const messages = geminiContentsToOpenAI(contents);
  return fetch(model.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${model.key}`,
    },
    body: JSON.stringify({
      model: model.model,
      messages,
      temperature,
      max_tokens: maxOutputTokens,
    }),
  });
}

/* ---- unified response parser ---- */
async function parseResponse(r, provider, label) {
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const status = r.status;
    const msg = provider === 'gemini'
      ? (e?.error?.message || '')
      : (e?.error?.message || e?.error || '');
    if (status === 429 || String(msg).includes('high demand') || String(msg).includes('quota') || String(msg).includes('rate_limit')) {
      return { err: 429, status, msg: 'Rate limited', retryable: true };
    }
    if (status >= 500) {
      return { err: status, status, msg: `${label} error (${status}): ${msg || 'server error'}`, retryable: true };
    }
    return { err: status, status, msg: `${label} error (${status}): ${msg || 'unknown'}`, retryable: false };
  }
  const json = await r.json();

  if (provider === 'gemini') {
    const candidate = json.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason === 'SAFETY') {
      return { err: 422, msg: 'Blocked by AI safety filter. Try a clearer image or PDF.', retryable: false };
    }
    const blockReason = json.promptFeedback?.blockReason;
    if (blockReason) {
      return { err: 422, msg: `AI blocked this content (${blockReason}).`, retryable: false };
    }
    const raw = candidate?.content?.parts?.[0]?.text || '';
    if (!raw) return { err: 502, msg: `${label} empty (finishReason: ${finishReason || '?'})`, retryable: true };
    return { raw };
  }

  // OpenAI-compatible (Groq)
  const raw = json.choices?.[0]?.message?.content || '';
  if (!raw) return { err: 502, msg: `${label} returned empty content.`, retryable: true };
  return { raw };
}

/* ---- call with automatic model fallback ---- */
async function callWithFallback(contents, opts, { needsVision = false } = {}) {
  const eligible = MODELS.filter(m => !needsVision || m.vision);
  if (!eligible.length) {
    return { err: 503, msg: 'No AI models configured. Add GEMINI_API_KEY to Vercel env vars.' };
  }

  let lastError = null;
  for (const model of eligible) {
    try {
      const caller = model.provider === 'gemini' ? callGeminiModel : callOpenAIModel;
      const r = await caller(model, contents, opts);
      const parsed = await parseResponse(r, model.provider, model.id);

      if (parsed.raw) {
        // Success
        return { raw: parsed.raw, modelId: model.id };
      }

      if (!parsed.retryable) {
        // Non-retryable error (safety block, bad request) — stop trying
        return parsed;
      }

      // Retryable — try next model
      lastError = parsed;
    } catch (fetchErr) {
      lastError = { err: 500, msg: `${model.id} fetch failed: ${fetchErr.message}`, retryable: true };
    }
  }

  return lastError || { err: 502, msg: 'All AI models failed.' };
}

/* ---- chat system context builder ---- */
function buildChatSystemContext(context, profile, skipIntake) {
  const roles = {
    coach: 'expert personal fitness coach and accountability buddy',
    plan: 'certified strength and conditioning coach',
    fuel: 'registered sports nutritionist',
    body: 'sports medicine physician and body-composition expert',
  };
  const schemas = {
    coach: '{"greeting":"warm personalised greeting using first name","insight":"2-3 sentences referencing their specific data","tip":"one actionable tip for today tailored to their goal","focus":"one word or short phrase — mental focus for today","labNote":"if labs present: one sentence connecting a lab finding to training/nutrition, else null"}',
    plan: '{"assessment":"2-3 sentence overall assessment of plan quality vs goal","strengths":["strength 1","strength 2"],"improvements":["specific improvement 1","specific improvement 2"],"recommendation":"2-3 sentence specific recommendation","weeklyFocus":"the single most important thing to focus on this week","labInsight":"if labs present: how a lab marker should influence their training, else null"}',
    fuel: '{"assessment":"2-3 sentence personalised assessment","highlights":["positive aspect 1","positive aspect 2"],"tips":["actionable tip 1","tip 2"],"timing":"meal-timing advice around their workouts","warning":"the single most important thing to watch out for, or null","labInsight":"if labs present: one specific nutrition adjustment from lab data, else null"}',
    body: '{"assessment":"2-3 sentence honest constructive assessment","bfInterpretation":"what their body fat % and trend means for their goal","priorities":["top action priority 1","top action priority 2"],"advice":"2-3 sentences of specific actionable advice grounded in data","encouragement":"one genuine motivating sentence","labInsight":"if labs present: one key body-composition implication from lab data, else null"}',
  };

  const labsNote = profile.labs
    ? `LAB RESULTS (use to personalise advice):\n${JSON.stringify(profile.labs)}`
    : 'LAB RESULTS: None uploaded';

  let prompt = `You are a ${roles[context]} for the Iron Ledger fitness app. Be warm, direct, and science-backed. Address the user by name when known.

USER PROFILE:
${JSON.stringify(profile, null, 2)}

${labsNote}

RULES — follow strictly:
1. Always respond with ONLY valid JSON. No prose outside the JSON.
2. During intake phase use: {"phase":"intake","message":"your question(s)","guidance":null}
3. During guidance phase use: {"phase":"guidance","message":"brief warm intro sentence","guidance":${schemas[context]}}
4. Ask 1-2 targeted questions relevant to your role (injuries, allergies, preferences, schedule, health context, etc.).
5. After 1-2 user responses you have enough info — switch to guidance phase.
6. Never assume — personalise based on the user's answers and profile data.
7. If lab data is present, reference relevant markers in your guidance.`;

  if (skipIntake) {
    prompt += '\n8. SKIP intake. Go directly to guidance phase using available profile data.';
  }

  return prompt;
}

/* ---- lab extraction prompts ---- */
function buildLabsTextPrompt(text) {
  return `You are a medical data extraction assistant. Extract all measurable health markers from this lab report text.

Instructions:
- Extract every test result you can find (blood panel, hormones, vitamins, metabolic markers, urine analysis, etc.)
- Use standard medical abbreviations for units (mg/dL, g/dL, IU/L, nmol/L, etc.)
- Note the reference range when visible
- Flag values outside normal range as "flag": "high" | "low"; within range as "flag": "normal"
- Only include markers you can clearly identify — do not guess

LAB REPORT TEXT:
${text}

Respond ONLY with valid JSON:
{
  "reportDate": "YYYY-MM-DD or null if not visible",
  "labName": "lab name or null",
  "markers": [
    {
      "name": "Haemoglobin",
      "value": 13.2,
      "unit": "g/dL",
      "refRange": "13.0-17.0",
      "flag": "normal"
    }
  ],
  "summary": "2-3 sentence plain-English summary of key findings and anything requiring attention"
}`;
}

function buildLabsImagePrompt() {
  return `You are a medical data extraction assistant. Extract all measurable health markers from this lab report image.

Instructions:
- Extract every test result you can find (blood panel, hormones, vitamins, metabolic markers, urine analysis, etc.)
- Use standard medical abbreviations for units (mg/dL, g/dL, IU/L, nmol/L, etc.)
- Note the reference range when visible
- Flag values outside normal range as "flag": "high" | "low"; within range as "flag": "normal"
- Only include markers you can clearly read — do not guess

Respond ONLY with valid JSON:
{
  "reportDate": "YYYY-MM-DD or null if not visible",
  "labName": "lab name or null",
  "markers": [
    {
      "name": "Haemoglobin",
      "value": 13.2,
      "unit": "g/dL",
      "refRange": "13.0-17.0",
      "flag": "normal"
    }
  ],
  "summary": "2-3 sentence plain-English summary of key findings and anything requiring attention"
}`;
}

/* ---- main handler ---- */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only.' });
  }

  if (!MODELS.length) {
    return res.status(503).json({
      ok: false,
      setup: true,
      error: 'No AI keys configured. Add GEMINI_API_KEY (and optionally GROQ_API_KEY) to Vercel env vars.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Send a JSON body.' });

  const { type } = body;

  /* ---- labs: vision extraction ---- */
  if (type === 'labs') {
    const { imageBase64, mimeType } = body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required for labs extraction.' });
    const mt = mimeType || 'image/jpeg';
    try {
      const contents = [{
        parts: [
          { text: buildLabsImagePrompt() },
          { inlineData: { mimeType: mt, data: imageBase64 } },
        ],
      }];
      const out = await callWithFallback(contents, { temperature: 0.1 }, { needsVision: true });
      if (out.err) return res.status(out.err).json({ error: out.msg });
      const result = strip(out.raw);
      if (!result) return res.status(502).json({ error: 'Could not parse lab extraction response.' });
      return res.status(200).json({ ok: true, result, model: out.modelId });
    } catch (err) {
      return res.status(500).json({ error: 'Labs extraction failed: ' + err.message });
    }
  }

  /* ---- labs-text: extract from PDF text ---- */
  if (type === 'labs-text') {
    const { text } = body;
    if (!text) return res.status(400).json({ error: 'text required for labs-text extraction.' });
    try {
      const contents = [{ parts: [{ text: buildLabsTextPrompt(text) }] }];
      const out = await callWithFallback(contents, { temperature: 0.1 }, { needsVision: false });
      if (out.err) return res.status(out.err).json({ error: out.msg });
      const result = strip(out.raw);
      if (!result) return res.status(502).json({ error: 'Could not parse lab extraction response.' });
      return res.status(200).json({ ok: true, result, model: out.modelId });
    } catch (err) {
      return res.status(500).json({ error: 'Labs text extraction failed: ' + err.message });
    }
  }

  /* ---- chat: conversational multi-turn ---- */
  if (type === 'chat') {
    const { context, messages, profile, skipIntake } = body;
    if (!['coach', 'plan', 'fuel', 'body'].includes(context)) {
      return res.status(400).json({ error: 'context must be coach | plan | fuel | body' });
    }

    const systemContext = buildChatSystemContext(context, profile || {}, skipIntake);
    const startDirective = skipIntake
      ? 'Provide guidance immediately based on available profile data. Respond in JSON with phase "guidance".'
      : 'Begin now. Ask your first intake question(s). Respond in JSON with phase "intake".';

    const geminiContents = [
      { role: 'user', parts: [{ text: systemContext + '\n\n' + startDirective }] },
    ];

    if (messages && messages.length > 0) {
      for (const msg of messages) {
        geminiContents.push({
          role: msg.role === 'model' ? 'model' : 'user',
          parts: [{ text: msg.text || '' }],
        });
      }
    }

    try {
      const out = await callWithFallback(geminiContents, { temperature: 0.75, maxOutputTokens: 2048 }, { needsVision: false });
      if (out.err) {
        if (out.status === 400) return res.status(503).json({ error: 'Invalid API key — check Vercel env vars.' });
        return res.status(out.err).json({ error: out.msg });
      }

      let result = strip(out.raw);
      if (!result) {
        result = { phase: 'intake', message: out.raw.slice(0, 600), guidance: null };
      }
      if (!result.phase) result.phase = 'intake';
      if (!result.message) result.message = '';

      return res.status(200).json({ ok: true, result, model: out.modelId });
    } catch (err) {
      return res.status(500).json({ error: 'AI chat failed: ' + err.message });
    }
  }

  return res.status(400).json({ error: 'type must be chat | labs | labs-text' });
}
