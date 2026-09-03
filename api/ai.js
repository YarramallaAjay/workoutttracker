/**
 * Iron Ledger — AI Coach endpoint
 * Model: Google Gemini 1.5 Flash (free tier: 15 RPM, ~1 M tokens/day)
 *
 * Setup:  get a free key → https://aistudio.google.com/app/apikey
 *         add GEMINI_API_KEY to Vercel env vars → redeploy.
 *
 * Types handled:
 *   coach  – personalised daily coaching message (Today tab)
 *   plan   – training split analysis (Plan tab)
 *   fuel   – nutrition/macro analysis (Fuel tab)
 *   body   – physique / body-composition analysis (Body tab)
 *   labs   – extract structured data from uploaded health-report image/PDF
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const FLASH = `${BASE}/gemini-3.6-flash:generateContent`;
const API_KEY = process.env.GEMINI_API_KEY || '';

/* ---- prompt builders --------------------------------------------------- */

function buildCoachPrompt(d) {
  return `You are an expert personal fitness coach, nutritionist and accountability buddy for the Iron Ledger gym app. Be warm, direct and science-backed. Address the user by name.

USER PROFILE
Name: ${d.name || 'there'} | Sex: ${d.sex} | Age: ${d.age} | Height: ${d.heightCm} cm | Weight: ${d.weightKg} kg
Goal: ${d.goalLabel} | Experience: ${d.experience} | ${d.days} days/week | Equipment: ${d.equipment}
Diet: ${d.diet} | Activity level: ${d.activity}

BODY COMPOSITION
Body fat: ${d.bf != null ? d.bf + '%' : 'not measured yet'} | FFMI: ${d.ffmi ?? 'unknown'} | Waist-to-height: ${d.wht ?? 'unknown'}

TRAINING HISTORY
Sessions this week: ${d.sessionsThisWeek}/${d.days} planned | Total sessions logged: ${d.totalSessions}
Current streak: ${d.streak} days | Last session: ${d.lastSession || 'none yet'}
Priority muscles: ${d.priorities?.length ? d.priorities.join(', ') : 'none set'}

LAB RESULTS / HEALTH DATA
${d.labs ? JSON.stringify(d.labs, null, 2) : 'No lab data uploaded yet'}

Give a motivating, personalised daily coaching message. If lab data is present, weave in any relevant health context (e.g. if testosterone is low, mention recovery/sleep; if haemoglobin is low, mention iron-rich foods in the diet). Keep it practical, not alarmist.

Respond ONLY with valid JSON:
{
  "greeting": "warm personalised greeting using their first name",
  "insight": "2-3 sentences of personalised insight referencing their specific data",
  "tip": "one specific actionable tip for today, tailored to their goal and recent history",
  "focus": "one word or short phrase — their mental focus for today",
  "labNote": "if labs present: one sentence connecting a lab finding to their training or nutrition, else null"
}`;
}

function buildPlanPrompt(d) {
  return `You are a certified strength and conditioning coach. Analyse this training plan and give expert, evidence-based feedback.

USER
Sex: ${d.sex} | Age: ${d.age} | Goal: ${d.goalLabel} | Experience: ${d.experience}
${d.days} days/week | Equipment: ${d.equipment}

CURRENT SPLIT: ${d.splitType}
${d.splitDays?.map(x => x.name + ': ' + x.exercises?.join(', ')).join('\n') || 'unknown'}

WEEKLY VOLUME (fractional sets per muscle):
${d.volume ? Object.entries(d.volume).map(([m, v]) => `  ${m}: ${v} sets`).join('\n') : 'unavailable'}

PRIORITY MUSCLES: ${d.priorities?.length ? d.priorities.join(', ') : 'none set'}

LAB / HEALTH DATA: ${d.labs ? JSON.stringify(d.labs) : 'none'}

If labs are present, factor in relevant markers (e.g. low testosterone → prioritise compound lifts + adequate sleep; high cortisol → reduce training frequency; low Vit D → note recovery impact).

Respond ONLY with valid JSON:
{
  "assessment": "2-3 sentence overall assessment of plan quality vs the user's goal",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "improvements": ["specific improvement 1", "specific improvement 2"],
  "recommendation": "2-3 sentence specific recommendation, referencing their experience/goal",
  "weeklyFocus": "the single most important thing to focus on this week",
  "labInsight": "if labs present: how a lab marker should influence their training, else null"
}`;
}

function buildFuelPrompt(d) {
  return `You are a registered sports nutritionist. Analyse this athlete's nutrition plan and give personalised, practical advice.

USER
Sex: ${d.sex} | Age: ${d.age} | Weight: ${d.weightKg} kg | Body fat: ${d.bf != null ? d.bf + '%' : 'unknown'}
Goal: ${d.goalLabel} | Diet type: ${d.diet} | Cuisine preference: ${d.cuisine} | Budget mode: ${d.budget ? 'yes' : 'no'}
Activity level: ${d.activity}

MACRO TARGETS (computed from Mifflin-St Jeor + goal adjustment)
Calories: ${d.targets?.kcal} kcal (TDEE: ${d.targets?.tdee} kcal)
Protein: ${d.targets?.protein} g (${d.targets?.proteinPerKg} g/kg) | Carbs: ${d.targets?.carb} g | Fat: ${d.targets?.fat} g

TODAY'S MEALS
${d.meals?.map(m => `${m.slot}: ${m.name} — ${m.kcal} kcal, P ${m.protein} g, C ${m.carbs} g, F ${m.fat} g`).join('\n') || 'no meals planned'}

ACTUAL DAILY TOTALS
${d.totals ? `${d.totals.kcal} kcal | P ${d.totals.protein} g | C ${d.totals.carbs} g | F ${d.totals.fat} g` : 'unknown'}

LAB / HEALTH DATA: ${d.labs ? JSON.stringify(d.labs) : 'none'}

If labs are present, personalise advice around findings (e.g. low ferritin → increase iron-rich foods; high LDL → reduce saturated fat; low B12 for vegetarian → supplementation note; low Vit D → fatty fish / fortification).

Respond ONLY with valid JSON:
{
  "assessment": "2-3 sentence personalised assessment",
  "highlights": ["positive aspect 1", "positive aspect 2"],
  "tips": ["specific, actionable tip 1 for their diet type and goal", "tip 2"],
  "timing": "meal-timing advice around their workouts",
  "warning": "the single most important thing to watch out for, or null",
  "labInsight": "if labs present: one specific nutrition adjustment from lab data, else null"
}`;
}

function buildBodyPrompt(d) {
  return `You are a sports medicine physician and body-composition expert. Give an honest, empathetic interpretation of these metrics.

USER
Sex: ${d.sex} | Age: ${d.age} | Height: ${d.heightCm} cm | Weight: ${d.weightKg} kg | Goal: ${d.goal}

BODY COMPOSITION (US Navy circumference method)
Body fat: ${d.bf != null ? d.bf + '%' : 'not measured'} (${d.bfBand || 'unknown category'})
Lean mass: ${d.lbm != null ? d.lbm + ' kg' : 'not calculated'} | FFMI (normalised): ${d.ffmi ?? 'not calculated'}

RATIOS
Waist-to-height: ${d.wht ?? 'not measured'} (NICE healthy threshold < 0.5)
Waist-to-hip: ${d.whr ?? 'not measured'}

PHOTO-DERIVED WIDTHS
Shoulder-to-waist ratio: ${d.sw ?? 'not measured'} (aesthetic target ${d.sex === 'female' ? '1.38' : '1.58'})
Shoulder width (height-scaled): ${d.shCm != null ? d.shCm + ' cm' : 'not measured'}

WEIGHT TREND (recent): ${d.weightTrend}

LAB / HEALTH DATA: ${d.labs ? JSON.stringify(d.labs) : 'none'}

If labs include hormones, lipids, glucose or vitamins, mention their implications for body composition, recovery or training adaptation. Be honest but constructive.

Respond ONLY with valid JSON:
{
  "assessment": "2-3 sentence honest, constructive assessment of current metrics",
  "bfInterpretation": "what their body fat % and trend means specifically for their goal",
  "priorities": ["top action priority 1", "top action priority 2"],
  "advice": "2-3 sentences of specific, actionable advice grounded in the data",
  "encouragement": "one genuine motivating sentence based on their data or potential",
  "labInsight": "if labs present: one key body-composition implication from the lab data, else null"
}`;
}

function buildLabsPrompt(imageBase64, mimeType) {
  return `You are a medical data extraction assistant. Extract all measurable health markers from this lab report / health document image.

Instructions:
- Extract every test result you can find (blood panel, hormones, vitamins, metabolic markers, urine analysis, etc.)
- Use standard medical abbreviations for units (mg/dL, g/dL, IU/L, nmol/L, etc.)
- Note the reference range when visible
- Flag anything outside the normal range as "flag": "high" | "low" | "normal"
- If the value is within range, flag it as "normal"
- Only include markers you can clearly read — do not guess
- Be thorough: extract all panels visible in the image

Respond ONLY with valid JSON in this exact format:
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

/* ---- main handler ------------------------------------------------------ */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only.' });
  }

  if (!API_KEY) {
    return res.status(503).json({
      error: 'AI coach not configured.',
      setup: 'Add GEMINI_API_KEY to Vercel env vars. Free key: https://aistudio.google.com/app/apikey',
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Send a JSON body.' });

  const { type, data, imageBase64, mimeType } = body;

  /* ---- labs: vision extraction ---- */
  if (type === 'labs') {
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required for labs extraction.' });
    const mt = mimeType || 'image/jpeg';

    try {
      const r = await fetch(`${FLASH}?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: buildLabsPrompt(imageBase64, mt) },
              { inlineData: { mimeType: mt, data: imageBase64 } },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: 'application/json' },
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        if (r.status === 429) return res.status(429).json({ error: 'Rate limit. Try again in a moment.' });
        return res.status(502).json({ error: 'AI error: ' + (e?.error?.message || r.status) });
      }
      const json = await r.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return res.status(502).json({ error: 'AI returned no content.' });
      let result;
      try { result = JSON.parse(text); }
      catch { const m = text.match(/\{[\s\S]*\}/); result = m ? JSON.parse(m[0]) : null; }
      if (!result) return res.status(502).json({ error: 'Could not parse AI response.' });
      return res.status(200).json({ ok: true, result });
    } catch (err) {
      return res.status(500).json({ error: 'Labs extraction failed: ' + err.message });
    }
  }

  /* ---- text analysis types ---- */
  const promptFns = {
    coach: buildCoachPrompt,
    plan: buildPlanPrompt,
    fuel: buildFuelPrompt,
    body: buildBodyPrompt,
  };
  const promptFn = promptFns[type];
  if (!promptFn) return res.status(400).json({ error: 'type must be coach | plan | fuel | body | labs.' });

  try {
    const r = await fetch(`${FLASH}?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptFn(data || {}) }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024, responseMimeType: 'application/json' },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        ],
      }),
    });

    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      if (r.status === 429) return res.status(429).json({ error: 'AI rate limit hit. Try again shortly.' });
      if (r.status === 400) return res.status(503).json({ error: 'Invalid GEMINI_API_KEY — check Vercel env vars.' });
      return res.status(502).json({ error: 'AI service error: ' + (e?.error?.message || r.status) });
    }

    const json = await r.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(502).json({ error: 'AI returned no content.' });

    let result;
    try { result = JSON.parse(text); }
    catch { const m = text.match(/\{[\s\S]*\}/); result = m ? JSON.parse(m[0]) : null; }
    if (!result) return res.status(502).json({ error: 'AI response could not be parsed.' });

    return res.status(200).json({ ok: true, result });
  } catch (err) {
    return res.status(500).json({ error: 'AI request failed: ' + err.message });
  }
}
