// Vercel Edge Function — Secure AI Proxy
// Primary: Groq (llama3-8b — fast & free tier)
// Fallback: Gemini 1.5 Flash (if Groq is rate-limited or fails)
// Your API keys stay on the server — never exposed to the browser.

export const config = { runtime: 'edge' };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── GROQ ──────────────────────────────────────────────────────────────────────
async function askGroq(systemPrompt, messages) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    }),
  });

  if (!res.ok) return null; // rate-limited or error → fall through to Gemini

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  return text || null;
}

// ── GEMINI ────────────────────────────────────────────────────────────────────
async function askGemini(systemPrompt, messages) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  // Convert OpenAI-style messages to Gemini format
  const contents = [
    { role: 'user',  parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: 'Understood. I will follow all instructions.' }] },
    ...messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
  ];

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents }),
  });

  if (!res.ok) return null;

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return text || null;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await req.json();
    const { system, messages } = body;

    // 1️⃣ Try Groq first (faster, free tier)
    let reply = await askGroq(system, messages);
    let source = 'groq';

    // 2️⃣ Fallback to Gemini if Groq fails
    if (!reply) {
      reply = await askGemini(system, messages);
      source = 'gemini';
    }

    // 3️⃣ Hard fallback if both fail
    if (!reply) {
      reply = "I'm having trouble right now. Please email mojangstudio908@gmail.com for direct support.";
      source = 'fallback';
    }

    return new Response(
      JSON.stringify({ reply, source }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'AI proxy error', detail: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}
