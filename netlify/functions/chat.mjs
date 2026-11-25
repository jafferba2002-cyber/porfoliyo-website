// Netlify Function: proxies chat messages to Google Gemini.
// The API key is read from the GEMINI_API_KEY environment variable set in the
// Netlify dashboard. It never appears in the browser or in this repository.

// Tried in order; later ones are fallbacks if a model is busy, rate-limited or retired.
const MODELS = [
  ...(process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL.trim()] : []),
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];
// 404 = model not found, 429 = rate limited, 500/503/504 = Google overloaded/temporary.
const RETRYABLE = new Set([404, 429, 500, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_MESSAGES = 12;        // conversation turns forwarded to the model
const MAX_CHARS = 1000;         // per user message

const SYSTEM_PROMPT = `You are the friendly assistant on the portfolio website of J. Jaffer Sadiq.
Answer questions about him briefly (2-4 sentences) and politely. Facts:
- Financial services professional based in Coimbatore, Tamil Nadu, India. Motto: "No way then make a way".
- Proprietor, Roja Traders (Dec 2020 - present): manufacturer and wholesale distributor of cattle feed and bran.
- Deputy Manager, Vistaar Financial Services P Ltd (Dec 2019 - June 2020): home loans, loans against property, mortgage loans; handled Coimbatore operations.
- Relationship Executive, Fedbank Financial Services Ltd (Nov 2018 - Aug 2019): mortgages, loans against property, home loan sourcing.
- Education: M.Com (International Business), Hindustan Arts & Science College, 2009; B.Com (Computer Applications), Shri Krishna Arts & Science College, 2006; Diploma in Computer Hardware.
- Skills: Microsoft Office, Windows OS, computer hardware, mortgage & property loans, customer service, banking, finance.
- Languages: English and Tamil. Hobby: vibe coding.
- Contact: info@jaffersadiq.com, phone 09994736006, WhatsApp https://wa.me/919994736006.
If you don't know something, say so and suggest using the contact form. Do not answer unrelated requests at length.`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: "Chat is not configured" }, 500);

  // Only accept requests from this site (set ALLOWED_ORIGIN in Netlify, e.g. https://jaffersadiq.com)
  const allowed = process.env.ALLOWED_ORIGIN;
  const origin = req.headers.get("origin");
  if (allowed && origin && !allowed.split(",").map((s) => s.trim()).includes(origin)) {
    return json({ error: "Forbidden" }, 403);
  }

  let messages;
  try {
    ({ messages } = await req.json());
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: "No messages" }, 400);
  }

  const contents = messages
    .slice(-MAX_MESSAGES)
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .map((m) => ({
      role: m.role === "bot" ? "model" : "user",
      parts: [{ text: m.text.slice(0, MAX_CHARS) }],
    }));

  if (!contents.length || contents[contents.length - 1].role !== "user") {
    return json({ error: "Invalid conversation" }, 400);
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { maxOutputTokens: 400, temperature: 0.6 },
  });

  try {
    let res;
    let lastError = "";
    for (const model of [...new Set(MODELS)]) {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey.trim() },
          body,
        }
      );
      if (res.ok) break;

      const errText = await res.text();
      console.error("Gemini error", model, res.status, errText);
      let msg = "";
      try { msg = JSON.parse(errText)?.error?.message || ""; } catch {}
      lastError = `Google API ${res.status}: ${msg || "unknown error"}`.slice(0, 300);
      // Bad key, bad request etc. won't be fixed by another model.
      if (!RETRYABLE.has(res.status)) break;
      if (res.status !== 404) await sleep(400);
    }

    if (!res.ok) {
      const busy = RETRYABLE.has(res.status) && res.status !== 404;
      return json(
        {
          error: busy
            ? "The assistant is very busy right now. Please try again in a minute."
            : `The assistant is unavailable right now (${lastError}).`,
        },
        busy ? 503 : 502
      );
    }

    const data = await res.json();
    const reply =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() ||
      "Sorry, I couldn't come up with an answer. Please try the contact form.";
    return json({ reply });
  } catch (err) {
    console.error(err);
    return json({ error: "The assistant is unavailable right now" }, 502);
  }
};

export const config = { path: "/api/chat" };
