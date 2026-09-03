/**
 * Iron Ledger — AI Coach endpoint
 * Model: Google Gemini Flash (free tier: 15 RPM, ~1 M tokens/day)
 *
 * Setup:  get a free key → https://aistudio.google.com/app/apikey
 *         add GEMINI_API_KEY to Vercel env vars → redeploy.
 *
 * Types handled:
 *   chat      – conversational AI (asks intake questions, then gives guidance)
 *   labs      – extract structured data from compressed lab report image
 *   labs-text – extract structured data from PDF-extracted text
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const FLASH = `${BASE}/gemini-3.6-flash:generateContent`;
const API_KEY = process.env.GEMINI_API_KEY || '';

/* ---- helpers ---- */
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

async function callGemini(contents, { temperature = 0.7, maxOutputTokens = 2048 } = {}) {
  const r = await fetch(`${FLASH}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature, maxOutputTokens },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      ],
    }),
  });
  return r;
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

/* ---- lab extraction prompt ---- */
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

/* ---- parse Gemini response: friendly errors for safety blocks, rate limits, etc. ---- */
async function parseGeminiResponse(r, label) {
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const msg = e?.error?.message || '';
    const status = r.status;
    if (status === 429 || msg.includes('high demand') || msg.includes('quota')) {
      return { err: 429, status, msg: 'AI is busy. Try again in a moment.' };
    }
    return { err: 502, status, msg: `${label} error (${status}): ${msg || 'unknown'}` };
  }
  const json = await r.json();
  const candidate = json.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason === 'SAFETY') {
    return { err: 422, status: 200, msg: 'The file was blocked by the AI safety filter. Try a clearer image or use the PDF option.' };
  }
  const blockReason = json.promptFeedback?.blockReason;
  if (blockReason) {
    return { err: 422, status: 200, msg: `AI blocked this content (${blockReason}). Try a different file.` };
  }
  const raw = candidate?.content?.parts?.[0]?.text || '';
  if (!raw) return { err: 502, status: 200, msg: `${label} returned empty content (finishReason: ${finishReason || 'unknown'}).` };
  return { raw };
}

/* ---- main handler ---- */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only.' });
  }

  if (!API_KEY) {
    return res.status(503).json({
      ok: false,
      setup: true,
      error: 'AI coach not configured.',
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
      const r = await callGemini([{
        parts: [
          { text: buildLabsImagePrompt() },
          { inlineData: { mimeType: mt, data: imageBase64 } },
        ],
      }], { temperature: 0.1 });

      const parsed = await parseGeminiResponse(r, 'Labs image');
      if (parsed.err) return res.status(parsed.err).json({ error: parsed.msg });
      const result = strip(parsed.raw);
      if (!result) return res.status(502).json({ error: 'Could not parse lab extraction response.' });
      return res.status(200).json({ ok: true, result });
    } catch (err) {
      return res.status(500).json({ error: 'Labs extraction failed: ' + err.message });
    }
  }

  /* ---- labs-text: extract from PDF text ---- */
  if (type === 'labs-text') {
    const { text } = body;
    if (!text) return res.status(400).json({ error: 'text required for labs-text extraction.' });
    try {
      const r = await callGemini([{
        parts: [{ text: buildLabsTextPrompt(text) }],
      }], { temperature: 0.1 });

      const parsed = await parseGeminiResponse(r, 'Labs text');
      if (parsed.err) return res.status(parsed.err).json({ error: parsed.msg });
      const result = strip(parsed.raw);
      if (!result) return res.status(502).json({ error: 'Could not parse lab extraction response.' });
      return res.status(200).json({ ok: true, result });
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

    // Build Gemini contents: system context as first user turn, then conversation history
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
      const r = await callGemini(geminiContents, { temperature: 0.75, maxOutputTokens: 2048 });

      const parsed = await parseGeminiResponse(r, 'Chat');
      if (parsed.err) {
        if (parsed.status === 400) return res.status(503).json({ error: 'Invalid GEMINI_API_KEY — check Vercel env vars.' });
        return res.status(parsed.err).json({ error: parsed.msg });
      }
      const raw = parsed.raw;

      let result = strip(raw);
      if (!result) {
        // Fallback: wrap as intake message so the client still shows something
        result = { phase: 'intake', message: raw.slice(0, 600), guidance: null };
      }
      // Ensure required fields
      if (!result.phase) result.phase = 'intake';
      if (!result.message) result.message = '';

      return res.status(200).json({ ok: true, result });
    } catch (err) {
      return res.status(500).json({ error: 'AI chat failed: ' + err.message });
    }
  }

  return res.status(400).json({ error: 'type must be chat | labs | labs-text' });
}
