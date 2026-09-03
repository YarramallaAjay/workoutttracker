/**
 * HealthPulse — AI endpoint (multi-model with automatic fallback)
 *
 * Models (all free tier):
 *   1. Gemini 3.6 Flash   — primary, supports vision  (GEMINI_API_KEY)
 *   2. Groq Qwen 3.6 27B  — text-only fallback        (GROQ_API_KEY)
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
  { id: 'groq-qwen', provider: 'openai', model: 'qwen/qwen3.6-27b', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_KEY, vision: false },
];
const MODELS = ALL_MODELS.filter(m => m.key);

/* ---- JSON extraction ---- */
function strip(raw) {
  // Remove Qwen/DeepSeek <think> blocks (including truncated ones without closing tag)
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<think>[\s\S]*/gi, ''); // truncated block — strip everything from <think> onward
  // Remove markdown code fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
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
  // Prepend instruction to avoid verbose chain-of-thought (Qwen <think> blocks)
  if (messages.length && messages[0].role === 'system') {
    messages[0].content = 'IMPORTANT: Respond with JSON only. Do NOT use <think> tags or chain-of-thought reasoning.\n\n' + messages[0].content;
  }
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
      max_tokens: Math.max(maxOutputTokens, 4096), // extra room in case model still thinks
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
    coach: 'expert health and wellness coach',
    plan: 'certified strength and conditioning coach who personalizes plans based on health data',
    fuel: 'registered nutritionist who creates meal plans based on health markers',
    body: 'sports medicine physician and body-composition expert',
    health: 'medical data analyst who explains health markers in plain language and recommends improvements',
    fab: 'helpful health assistant who can update user data based on requests',
  };
  const schemas = {
    coach: '{"greeting":"warm personalised greeting using first name","insight":"2-3 sentences referencing their specific health data","tip":"one actionable health tip for today","focus":"one word or short phrase — health focus for today","labNote":"if labs present: one sentence connecting a lab finding to their health, else null"}',
    plan: '{"assessment":"2-3 sentence overall assessment of plan quality vs health goals","strengths":["strength 1","strength 2"],"improvements":["specific improvement 1","specific improvement 2"],"recommendation":"2-3 sentence specific recommendation considering health markers","weeklyFocus":"the single most important thing to focus on this week","labInsight":"if labs present: how a lab marker should influence their training, else null"}',
    fuel: '{"assessment":"2-3 sentence personalised nutrition assessment","highlights":["positive aspect 1","positive aspect 2"],"tips":["actionable tip 1","tip 2"],"timing":"meal-timing advice around their workouts","warning":"the single most important thing to watch out for, or null","labInsight":"if labs present: one specific nutrition adjustment from lab data, else null"}',
    body: '{"assessment":"2-3 sentence honest constructive assessment","bfInterpretation":"what their body fat % and trend means for their goal","priorities":["top action priority 1","top action priority 2"],"advice":"2-3 sentences of specific actionable advice grounded in data","encouragement":"one genuine motivating sentence","labInsight":"if labs present: one key body-composition implication from lab data, else null"}',
    health: '{"assessment":"2-3 sentence overview of health status based on markers","categories":[{"name":"category name","status":"good|warn|bad","summary":"brief explanation"}],"recommendations":["specific actionable recommendation 1","recommendation 2","recommendation 3"],"labInsight":"most important finding from lab data","encouragement":"one encouraging sentence about their health journey"}',
    fab: '{"message":"helpful response to the user request","dataChanges":null}',
  };

  const labsNote = profile.labs
    ? `LAB RESULTS (use to personalise advice):\n${JSON.stringify(profile.labs)}`
    : 'LAB RESULTS: None uploaded';

  let prompt = `You are a ${roles[context]} for the HealthPulse health tracking app. Be warm, direct, and science-backed. Address the user by name when known.

USER PROFILE:
${JSON.stringify(profile, null, 2)}

${labsNote}

RULES — follow strictly:
1. Always respond with ONLY valid JSON. No prose outside the JSON.
2. During intake phase use: {"phase":"intake","message":"your question(s)","guidance":null}
3. During guidance phase use: {"phase":"guidance","message":"brief warm intro sentence","guidance":${schemas[context]}}
4. Ask 1-2 targeted questions relevant to your role (health conditions, allergies, preferences, health goals, etc.).
5. After 1-2 user responses you have enough info — switch to guidance phase.
6. Never assume — personalise based on the user's answers and profile/health data.
7. If lab data is present, ALWAYS reference relevant markers in your guidance.`;

  if (context === 'fab') {
    prompt += `\n8. This is a quick-chat assistant. The user is asking to update their health data or get quick answers about their health.
9. Respond conversationally but always in JSON format: {"phase":"guidance","message":"your helpful response","guidance":{"message":"detailed response","dataChanges":null}}
10. If the user asks about their health markers, reference their lab data directly.`;
  }

  if (skipIntake) {
    prompt += '\n' + (context === 'fab' ? '11' : '8') + '. SKIP intake. Go directly to guidance phase using available profile data.';
  }

  return prompt;
}

/* ---- lab extraction prompts ---- */
function buildLabsTextPrompt(text, preExtracted, reportDate) {
  if (preExtracted) {
    // Data already parsed client-side into structured rows
    return `You are a medical data extraction assistant. The client has already extracted test results from a lab report PDF. Each line follows this format:
TEST: <name> | VALUE: <number> [unit] | REF: <reference range> | STATUS: <flag> | SECTION: <category>

Your job:
1. Normalize each test name to its standard medical name (e.g., "SGPT" → "ALT (SGPT)", "Hb" → "Hemoglobin")
2. If a reference range is provided, compare the value to determine flag (normal/high/low)
3. If STATUS was provided from the report, use it as a hint but verify against the reference range
4. Add the correct unit if missing (use standard medical units)
5. Skip any rows that are clearly NOT medical tests (headers, totals, notes)
6. Do NOT include duplicate tests — each marker should appear exactly once

PRE-EXTRACTED TEST DATA:
${text}

${reportDate ? `REPORT DATE FOUND: ${reportDate}` : ''}

Respond ONLY with valid JSON:
{
  "reportDate": "${reportDate || 'null'}",
  "markers": [
    {
      "name": "Hemoglobin",
      "value": 13.2,
      "unit": "g/dL",
      "refRange": "13.0-17.0",
      "flag": "normal"
    }
  ],
  "summary": "2-3 sentence plain-English summary highlighting key findings, any values outside normal range, and what needs attention"
}`;
  }

  // Fallback: raw text (noise-filtered but not parsed into rows)
  return `You are a medical data extraction assistant. Extract all measurable health markers from this lab report text.

The text below is from a PDF lab report with hospital info and headers already stripped. Focus ONLY on test results.

Instructions:
- Find every test result: look for patterns like "Test Name [tab/space] numeric value [space] unit [space] reference range"
- Extract: test name, numeric value, unit, reference range
- Compare value to reference range to set flag: "normal" (within range), "high" (above), "low" (below)
- Use standard medical names and abbreviations for units
- Each marker should appear exactly ONCE — no duplicates
- Ignore non-test data (patient info, hospital details, notes, dates, page numbers)

LAB REPORT TEXT:
${text}

Respond ONLY with valid JSON:
{
  "reportDate": "YYYY-MM-DD or null",
  "markers": [
    {
      "name": "Hemoglobin",
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
    const { text, preExtracted, reportDate } = body;
    if (!text) return res.status(400).json({ error: 'text required for labs-text extraction.' });
    try {
      const contents = [{ parts: [{ text: buildLabsTextPrompt(text, preExtracted, reportDate) }] }];
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
    if (!['coach', 'plan', 'fuel', 'body', 'health', 'fab'].includes(context)) {
      return res.status(400).json({ error: 'context must be coach | plan | fuel | body | health | fab' });
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
        const cleaned = out.raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
        result = { phase: 'intake', message: (cleaned || out.raw).slice(0, 600), guidance: null };
      }
      if (!result.phase) result.phase = 'intake';
      if (!result.message) result.message = '';

      return res.status(200).json({ ok: true, result, model: out.modelId });
    } catch (err) {
      return res.status(500).json({ error: 'AI chat failed: ' + err.message });
    }
  }

  /* ---- workout-plan: AI-generated weekly workout plan ---- */
  if (type === 'workout-plan') {
    const { profile } = body;
    if (!profile) return res.status(400).json({ error: 'profile required for workout-plan.' });

    const labsNote = profile.labs
      ? `LAB RESULTS (adjust plan based on these):\n${JSON.stringify(profile.labs)}`
      : 'LAB RESULTS: None uploaded';

    const prompt = `You are an expert certified strength and conditioning coach. Create a personalized weekly workout plan.

USER PROFILE:
${JSON.stringify(profile, null, 2)}

${labsNote}

Create a ${profile.days || 4}-day workout plan considering:
- Experience level: ${profile.experience || 'beginner'}
- Equipment: ${profile.equipment === 'full' ? 'full gym' : profile.equipment === 'home' ? 'dumbbells at home' : 'bodyweight and bands'}
- Goal: ${profile.goal || 'muscle'}
- Any health conditions from lab data (e.g., low vitamin D → lighter intensity, hormonal issues → adjusted volume)

Respond ONLY with valid JSON:
{
  "planName": "Short descriptive name for the plan",
  "description": "1-2 sentence overview of the plan approach",
  "days": [
    {
      "name": "Day name (e.g., Upper Body Push)",
      "focus": "Primary muscle groups",
      "warmup": "Brief warmup instructions",
      "exercises": [
        {
          "name": "Exercise name",
          "sets": 3,
          "reps": "8-12",
          "rest": "90s",
          "notes": "Brief form cue or tip",
          "alternatives": ["Alternative exercise 1"]
        }
      ],
      "cooldown": "Brief cooldown instructions"
    }
  ],
  "weeklyNotes": "1-2 sentences of overall weekly guidance",
  "labBasedAdjustments": "If labs present: specific adjustments made based on lab data, else null"
}`;

    try {
      const contents = [{ parts: [{ text: prompt }] }];
      const out = await callWithFallback(contents, { temperature: 0.7, maxOutputTokens: 4096 }, { needsVision: false });
      if (out.err) return res.status(out.err).json({ error: out.msg });
      const result = strip(out.raw);
      if (!result) return res.status(502).json({ error: 'Could not parse workout plan response.' });
      return res.status(200).json({ ok: true, result, model: out.modelId });
    } catch (err) {
      return res.status(500).json({ error: 'Workout plan generation failed: ' + err.message });
    }
  }

  /* ---- meal-plan: AI-generated meal plan with recipes ---- */
  if (type === 'meal-plan') {
    const { profile } = body;
    if (!profile) return res.status(400).json({ error: 'profile required for meal-plan.' });

    const labsNote = profile.labs
      ? `LAB RESULTS (personalize nutrition based on these):\n${JSON.stringify(profile.labs)}`
      : 'LAB RESULTS: None uploaded';

    const prompt = `You are a registered nutritionist. Create a personalized daily meal plan with full recipes.

USER PROFILE:
${JSON.stringify(profile, null, 2)}

${labsNote}

Create a meal plan considering:
- Diet preference: ${profile.diet || 'veg'} (${profile.diet === 'nonveg' ? 'non-vegetarian' : profile.diet === 'egg' ? 'egg + vegetarian' : profile.diet === 'vegan' ? 'vegan' : 'vegetarian'})
- Cuisine: ${profile.cuisine === 'indian' ? 'Indian' : 'Any cuisine'}
- Budget-friendly: ${profile.budget ? 'Yes' : 'No'}
- Goal: ${profile.goal || 'muscle'} (adjust macros accordingly)
- Any health markers from lab data (e.g., high cholesterol → low saturated fat, high blood sugar → low GI foods)

Respond ONLY with valid JSON:
{
  "planName": "Short descriptive name for the meal plan",
  "description": "1-2 sentence overview",
  "targetCalories": 2200,
  "macros": { "protein": 150, "carbs": 250, "fat": 70 },
  "meals": [
    {
      "slot": "breakfast",
      "name": "Meal name",
      "ingredients": [
        { "item": "Ingredient name", "quantity": "amount with unit" }
      ],
      "recipe": "Step-by-step cooking instructions (2-4 sentences)",
      "prepTime": "15 min",
      "macros": { "calories": 450, "protein": 30, "carbs": 50, "fat": 15 }
    }
  ],
  "shoppingList": ["item 1", "item 2"],
  "labBasedAdjustments": "If labs present: specific nutrition adjustments from lab data, else null",
  "tips": ["Nutritional tip 1", "Tip 2"]
}`;

    try {
      const contents = [{ parts: [{ text: prompt }] }];
      const out = await callWithFallback(contents, { temperature: 0.7, maxOutputTokens: 4096 }, { needsVision: false });
      if (out.err) return res.status(out.err).json({ error: out.msg });
      const result = strip(out.raw);
      if (!result) return res.status(502).json({ error: 'Could not parse meal plan response.' });
      return res.status(200).json({ ok: true, result, model: out.modelId });
    } catch (err) {
      return res.status(500).json({ error: 'Meal plan generation failed: ' + err.message });
    }
  }

  return res.status(400).json({ error: 'type must be chat | labs | labs-text | workout-plan | meal-plan' });
}
