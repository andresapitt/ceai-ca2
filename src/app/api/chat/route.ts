import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  Type,
  type FunctionDeclaration,
} from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

export const runtime = "nodejs";

type ChatMessage = {
  role: "user" | "model";
  text: string;
};

const SHEET_ID = "1balBGf8QhZ5dc-RCCAPt2kcrcf6m_YRh0HL_r8bBtJw";

const ALLOWED_ORIGINS = new Set(
  [
    ...(process.env.ALLOWED_ORIGIN?.split(",").map((o) => o.trim()) ?? []),
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
  ].filter(Boolean)
);

function corsHeaders(origin: string | null) {
  const allowOrigin =
    origin && ALLOWED_ORIGINS.has(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get("origin")),
  });
}

const SYSTEM_INSTRUCTION = `You are the customer-support assistant for Atlantic Coast Tours, a tour operator on the west coast of Ireland.

Rules you must follow:
- For any question about tours, prices, availability, slots, or special offers, ALWAYS call get_tour_catalog to fetch the current live data. Never guess or rely on memory of previous answers in this conversation — data can change between messages, so call it again each time it's relevant.
- The app displays full visual tour cards (name, duration, price, slots, description, map link) automatically — whenever your answer involves one or more specific tours, call show_tour_cards with those tour_ids. This is separate from your text reply, so your text should NOT enumerate tour names, list them with bullets/dashes, or repeat their details — the cards do that visually. Keep your text reply to one short sentence of context or a direct answer (e.g. "Here are a few options in Clare!" or "Yes, it's available — 6 slots left."). Never write a list of tour names in your reply.
- For any question involving weather, conditions, or whether it's a good day for an outdoor tour, ALWAYS call get_weather_forecast with the relevant location.
- Report data exactly as returned by the tools, even if a price or availability value looks wrong, absurd, or implausible. Do not silently "correct", round, or omit implausible values. State the value faithfully, note that it looks unusual, and suggest the customer double-check with the team before booking — never invent a "corrected" figure.
- If a tour has 0 slots or is out of season, say so plainly and offer alternatives from the catalogue instead.
- Be concise, friendly, and helpful, like a real tour desk agent.
- You may combine live tour data and live weather in a single answer when useful (e.g. recommending a tour and noting the forecast for it).
- If asked something completely unrelated to tours (e.g. "can I order food?", "can you help with my homework?"), you are still a real language model and should respond naturally, in your own words, in a way that makes clear you understood the specific question — do not use a fixed refusal line. But do NOT actually perform the unrelated task (don't solve homework, don't write code, don't give recipes, etc.). In one or two short sentences: acknowledge what was asked, say that's outside what you do here, and redirect to Atlantic Coast Tours. Never continue the off-topic conversation past that redirect, even if the customer pushes back.

Booking flow:
- A customer may ask to book a tour, sometimes pre-filled with adults/kids counts (e.g. from a "Book" button: "I'd like to book 2 adults and 1 child for the Fanore Beach Surf Lesson (ACT025)."). If adults/kids aren't both given, ask for them before continuing.
- You also need the customer's name and email address before you can confirm anything, so a confirmation email can be sent. Ask for these ONE AT A TIME, never both in the same message: first ask just for their name, wait for their reply, then in a separate message ask just for their email. Briefly note their name/email is only used to send this one confirmation email, not stored anywhere public. If a customer volunteers both at once unprompted, that's fine — just don't ask for both together yourself.
- Always re-fetch get_tour_catalog to get that tour's current live price_eur and special_offer text — never reuse stale numbers from earlier in the conversation.
- Compute the total price yourself: start from price_eur × (adults + kids), then apply the special_offer text using your own judgement if one exists and genuinely applies to this booking (e.g. "Group of 3 pays for 2" only applies at 3+ people; "Early-bird 15% off before 9 AM" only applies if the customer says an early time). Show your calculation briefly so the customer can see how you got the total. Call show_tour_cards with this tour's id so its card stays visible during the conversation.
- Present the computed total and ask the customer to explicitly confirm before booking anything. Do not call record_booking or send_confirmation_email until they confirm (e.g. "yes", "confirm", "book it").
- Only after explicit confirmation: (1) call record_booking with the tour_id, tour_name, adults, kids, and the final total_price — this log never includes the customer's name or email; then (2) call send_confirmation_email with the customer's name, email, and the same booking details, using the booking_reference record_booking returned.
- After both calls, tell the customer their booking is confirmed and a confirmation email is on its way, with a friendly summary. If either call returns an error, apologise for that specific part (log vs email) and tell them to contact the team directly if needed — never pretend something succeeded that didn't.
- Never fabricate a total price without first fetching live tour data for that specific tour in this turn or a very recent one.`;

const functionDeclarations: FunctionDeclaration[] = [
  {
    name: "get_tour_catalog",
    description:
      "Fetch the live, up-to-date Atlantic Coast Tours catalogue (tour id, name, category, location, meeting point, price in EUR, duration, capacity, availability window, slots remaining this week, special offers, description) directly from the company's live Google Sheet. Always call this fresh — never reuse a previous result — since prices and availability can change at any time.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "get_weather_forecast",
    description:
      "Get the live current weather and short-term forecast for a named location on the west coast of Ireland, used to advise customers on outdoor tour conditions.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        location: {
          type: Type.STRING,
          description:
            "Bare town/village name only, e.g. 'Fanore' or 'Westport' — do not include county or 'Co.' prefixes.",
        },
      },
      required: ["location"],
    },
  },
  {
    name: "show_tour_cards",
    description:
      "Tell the app which tours to display as visual cards to the customer right now. Call this whenever your answer discusses one or more specific tours (after fetching get_tour_catalog), instead of listing tour details in your text reply.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        tour_ids: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "The tour_id values to display, e.g. ['ACT025', 'ACT011'].",
        },
      },
      required: ["tour_ids"],
    },
  },
  {
    name: "record_booking",
    description:
      "Log a confirmed tour booking (no customer personal data — just tour and party size) to the live booking log, after the customer has explicitly confirmed the computed total price. Never call this before confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        tour_id: { type: Type.STRING, description: "The tour's id, e.g. 'ACT025'." },
        tour_name: { type: Type.STRING, description: "The tour's name." },
        adults: { type: Type.NUMBER, description: "Number of adults." },
        kids: { type: Type.NUMBER, description: "Number of children." },
        total_price: {
          type: Type.NUMBER,
          description: "Final total price in EUR, after applying any special offer.",
        },
      },
      required: ["tour_id", "tour_name", "adults", "kids", "total_price"],
    },
  },
  {
    name: "send_confirmation_email",
    description:
      "Send the customer a booking confirmation email. Only call this after record_booking has succeeded and you have the customer's name and email.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Customer's name." },
        email: { type: Type.STRING, description: "Customer's email address." },
        tour_name: { type: Type.STRING },
        adults: { type: Type.NUMBER },
        kids: { type: Type.NUMBER },
        total_price: { type: Type.NUMBER },
        booking_reference: {
          type: Type.STRING,
          description: "The booking_reference returned by record_booking.",
        },
      },
      required: [
        "name",
        "email",
        "tour_name",
        "adults",
        "kids",
        "total_price",
        "booking_reference",
      ],
    },
  },
];

const tools = [{ functionDeclarations }];

type SheetCell = { v: unknown; f?: string } | null;
type SheetRow = { c: SheetCell[] };

async function getTourCatalog() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=Sheet1`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    return { error: `Failed to fetch live tour catalogue (status ${res.status}).` };
  }
  const raw = await res.text();
  const jsonText = raw.replace(/^[\s\S]*?setResponse\(/, "").replace(/\);?\s*$/, "");
  const data = JSON.parse(jsonText);

  const cols: string[] = data.table.cols.map(
    (c: { label?: string; id: string }) => c.label || c.id
  );
  const rows: SheetRow[] = data.table.rows;

  const tours = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    row.c.forEach((cell, i) => {
      const key = cols[i];
      if (!key) return;
      obj[key] = cell ? cell.v : null;
    });
    return obj;
  });

  return { fetched_at: new Date().toISOString(), tour_count: tours.length, tours };
}

type GeoResult = {
  name: string;
  latitude: number;
  longitude: number;
  country_code?: string;
  admin1?: string;
  admin2?: string;
};

async function geocode(name: string): Promise<GeoResult | null> {
  // Open-Meteo's `country` query param is not a reliable filter (it returns
  // the same global results with or without it), so fetch several candidates
  // and prefer an Irish match ourselves rather than trusting the API to filter.
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    name
  )}&count=10`;
  const geoRes = await fetch(geoUrl, { cache: "no-store" });
  if (!geoRes.ok) return null;
  const geoData = await geoRes.json();
  const results: GeoResult[] = geoData.results ?? [];
  return results.find((r) => r.country_code === "IE") ?? results[0] ?? null;
}

async function getWeatherForecast(location: string) {
  // Geocoding wants a bare place name, not "Place, Co. County" — try
  // progressively simpler variants of what the model passed in.
  const candidates = [
    location,
    location.split(",")[0].trim(),
    location.replace(/\bco\.?\s+/i, "").split(",")[0].trim(),
  ].filter((v, i, arr) => v && arr.indexOf(v) === i);

  let place = null;
  for (const candidate of candidates) {
    place = await geocode(candidate);
    if (place) break;
  }

  if (!place) {
    return { error: `Could not find a location matching "${location}" in Ireland.` };
  }

  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,precipitation,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=Europe%2FDublin&forecast_days=3`;
  const weatherRes = await fetch(weatherUrl, { cache: "no-store" });
  if (!weatherRes.ok) {
    return { error: `Failed to fetch live weather for "${location}".` };
  }
  const weather = await weatherRes.json();

  return {
    fetched_at: new Date().toISOString(),
    location: place.name,
    admin_area: place.admin2 || place.admin1,
    latitude: place.latitude,
    longitude: place.longitude,
    current: weather.current,
    daily_forecast: weather.daily,
  };
}

type BookingArgs = {
  tour_id: string;
  tour_name: string;
  adults: number;
  kids: number;
  total_price: number;
};

function base64url(input: Buffer | string) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

// Google Sheets writes need real auth even on a "public" sheet — this signs a
// short-lived JWT with the service account's key and exchanges it for an
// OAuth2 access token (the standard service-account "JWT Bearer" flow),
// caching the token in-memory for the life of this serverless instance.
function normalizePemKey(raw: string): string {
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, "\n").trim();
}

function resolveServiceAccountCredentials(): { email: string; privateKey: string } | null {
  const envEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKeyVar = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!rawKeyVar) return null;

  const trimmed = rawKeyVar.trim();
  // Accept either the raw PEM value, or the whole downloaded JSON key file
  // pasted in as-is — both are common depending on how it was copied.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.private_key) {
        return {
          email: envEmail || parsed.client_email || "",
          privateKey: normalizePemKey(String(parsed.private_key)),
        };
      }
    } catch (err) {
      console.error("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY looks like JSON but failed to parse:", err);
      return null;
    }
  }

  if (!envEmail) return null;
  return { email: envEmail, privateKey: normalizePemKey(trimmed) };
}

async function getGoogleAccessToken(): Promise<string | null> {
  const creds = resolveServiceAccountCredentials();
  if (!creds || !creds.email || !creds.privateKey) return null;
  const { email, privateKey } = creds;

  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 30_000) {
    return cachedAccessToken.token;
  }

  if (!privateKey.startsWith("-----BEGIN")) {
    console.error(
      `Service account private key doesn't look like a PEM key after normalizing (starts with: ${privateKey.slice(0, 15)}...).`
    );
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  let jwt: string;
  try {
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey);
    jwt = `${unsigned}.${base64url(signature)}`;
  } catch (err) {
    console.error("Failed to sign JWT with GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:", err);
    return null;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    console.error("Google token exchange failed:", await res.text());
    return null;
  }
  const data = await res.json();
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

let cachedFirstSheetTitle: { sheetId: string; title: string } | null = null;

// Guessing "Sheet1" breaks the moment someone renames the tab (which Google
// often does automatically) — so ask the API for the real first tab title.
async function getFirstSheetTitle(sheetId: string, accessToken: string): Promise<string | null> {
  if (cachedFirstSheetTitle && cachedFirstSheetTitle.sheetId === sheetId) {
    return cachedFirstSheetTitle.title;
  }
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    console.error("Failed to fetch spreadsheet metadata:", await res.text());
    return null;
  }
  const data = await res.json();
  const title = data.sheets?.[0]?.properties?.title;
  if (!title) return null;
  cachedFirstSheetTitle = { sheetId, title };
  return title;
}

async function recordBooking(args: BookingArgs) {
  const sheetId = process.env.BOOKING_SHEET_ID;
  if (!sheetId) {
    return { error: "Booking system is not connected yet." };
  }

  const accessToken = await getGoogleAccessToken();
  if (!accessToken) {
    return { error: "Booking system is not connected yet." };
  }

  let range = process.env.BOOKING_SHEET_RANGE;
  if (!range) {
    const title = await getFirstSheetTitle(sheetId, accessToken);
    if (!title) {
      return { error: "Could not determine the booking sheet's tab name." };
    }
    range = `${title}!A:F`;
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(
    range
  )}:append?valueInputOption=USER_ENTERED`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        values: [
          [
            new Date().toISOString(),
            args.tour_id,
            args.tour_name,
            args.adults,
            args.kids,
            args.total_price,
          ],
        ],
      }),
    });
    if (!res.ok) {
      console.error("Sheets append failed:", await res.text());
      return { error: "Failed to write booking to the live sheet." };
    }
    return {
      success: true,
      booking_reference: `ACT-${Date.now().toString(36).toUpperCase()}`,
    };
  } catch (err) {
    console.error("Booking write failed:", err);
    return { error: "Failed to write booking to the live sheet." };
  }
}

type ConfirmationEmailArgs = {
  name: string;
  email: string;
  tour_name: string;
  adults: number;
  kids: number;
  total_price: number;
  booking_reference: string;
};

async function sendConfirmationEmail(args: ConfirmationEmailArgs) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    return { error: "Email system is not connected yet." };
  }

  const partyLine =
    args.kids > 0
      ? `${args.adults} adult${args.adults === 1 ? "" : "s"} and ${args.kids} child${args.kids === 1 ? "" : "ren"}`
      : `${args.adults} adult${args.adults === 1 ? "" : "s"}`;

  const html = `
    <p>Hi ${escapeHtmlForEmail(args.name)},</p>
    <p>Your Atlantic Coast Tours booking is confirmed!</p>
    <ul>
      <li><strong>Booking reference:</strong> ${escapeHtmlForEmail(args.booking_reference)}</li>
      <li><strong>Tour:</strong> ${escapeHtmlForEmail(args.tour_name)}</li>
      <li><strong>Party:</strong> ${escapeHtmlForEmail(partyLine)}</li>
      <li><strong>Total:</strong> €${args.total_price}</li>
    </ul>
    <p>See you on the coast!<br/>Atlantic Coast Tours</p>
  `;

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: args.email }] }],
        from: { email: fromEmail, name: "Atlantic Coast Tours" },
        subject: `Booking confirmed — ${args.tour_name} (${args.booking_reference})`,
        content: [{ type: "text/html", value: html }],
      }),
    });
    if (!res.ok) {
      console.error(`SendGrid send failed (status ${res.status}):`, await res.text());
      return { error: "Failed to send the confirmation email." };
    }
    return { success: true };
  } catch (err) {
    console.error("Email send failed:", err);
    return { error: "Failed to send the confirmation email." };
  }
}

function escapeHtmlForEmail(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Google periodically retires/renames free-tier model ids and rate-limits are
// per-model, so probe a shortlist and stick with whichever one actually works
// for this key, rather than hardcoding a single name that can break later.
const MODEL_CANDIDATES = [
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
];
let cachedWorkingModel: string | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateContentWithFallback(ai: GoogleGenAI, params: any) {
  const candidates = cachedWorkingModel
    ? [cachedWorkingModel, ...MODEL_CANDIDATES.filter((m) => m !== cachedWorkingModel)]
    : MODEL_CANDIDATES;

  let lastErr: unknown;
  for (const model of candidates) {
    try {
      const response = await ai.models.generateContent({ ...params, model });
      cachedWorkingModel = model;
      return response;
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const isRetryable = status === 404 || status === 429;
      if (!isRetryable) throw err;
      console.warn(`Model "${model}" unavailable (status ${status}), trying next candidate.`);
    }
  }
  throw lastErr;
}

async function executeFunctionCall(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "get_tour_catalog":
      return getTourCatalog();
    case "get_weather_forecast":
      return getWeatherForecast(String(args.location ?? ""));
    case "record_booking":
      return recordBooking({
        tour_id: String(args.tour_id ?? ""),
        tour_name: String(args.tour_name ?? ""),
        adults: Number(args.adults ?? 0),
        kids: Number(args.kids ?? 0),
        total_price: Number(args.total_price ?? 0),
      });
    case "show_tour_cards":
      return { ok: true };
    case "send_confirmation_email":
      return sendConfirmationEmail({
        name: String(args.name ?? ""),
        email: String(args.email ?? ""),
        tour_name: String(args.tour_name ?? ""),
        adults: Number(args.adults ?? 0),
        kids: Number(args.kids ?? 0),
        total_price: Number(args.total_price ?? 0),
        booking_reference: String(args.booking_reference ?? ""),
      });
    default:
      return { error: `Unknown function: ${name}` };
  }
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing GEMINI_API_KEY." },
      { status: 500, headers }
    );
  }

  let body: { messages?: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers });
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json(
      { error: "Request must include a non-empty 'messages' array." },
      { status: 400, headers }
    );
  }

  const ai = new GoogleGenAI({ apiKey });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contents: any[] = messages.map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  const toolsUsed: string[] = [];
  let lastWeather: Awaited<ReturnType<typeof getWeatherForecast>> | null = null;
  let lastCatalog: Awaited<ReturnType<typeof getTourCatalog>> | null = null;
  let displayTourIds: string[] = [];

  try {
    for (let turn = 0; turn < 5; turn++) {
      const response = await generateContentWithFallback(ai, {
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          tools,
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
          },
        },
      });

      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        // Push the raw model content (not a reconstructed one) so fields
        // like thoughtSignature — required by some models to keep a
        // function-calling turn coherent — survive into the next request.
        const modelContent = response.candidates?.[0]?.content;
        contents.push(
          modelContent ?? {
            role: "model",
            parts: functionCalls.map((fc) => ({ functionCall: fc })),
          }
        );

        const responseParts = await Promise.all(
          functionCalls.map(async (fc) => {
            const name = fc.name ?? "";
            const args = (fc.args as Record<string, unknown>) ?? {};
            toolsUsed.push(name);
            const result = await executeFunctionCall(name, args);
            if (name === "get_weather_forecast" && !("error" in result)) {
              lastWeather = result as Awaited<ReturnType<typeof getWeatherForecast>>;
            }
            if (name === "get_tour_catalog" && !("error" in result)) {
              lastCatalog = result as Awaited<ReturnType<typeof getTourCatalog>>;
            }
            if (name === "show_tour_cards" && Array.isArray(args.tour_ids)) {
              displayTourIds = displayTourIds.concat(args.tour_ids.map(String));
            }
            return {
              functionResponse: {
                name,
                response: { result },
              },
            };
          })
        );

        contents.push({ role: "user", parts: responseParts });
        continue;
      }

      const replyText = response.text ?? "";
      const catalogSnapshot = lastCatalog;
      let matchedTours: Record<string, unknown>[] | null = null;
      if (catalogSnapshot && !("error" in catalogSnapshot) && displayTourIds.length > 0) {
        const tours = (catalogSnapshot as { tours: Record<string, unknown>[] }).tours;
        const idSet = new Set(displayTourIds);
        matchedTours = tours.filter((t) => idSet.has(String(t.tour_id ?? "")));
        if (matchedTours.length === 0) matchedTours = null;
      }

      return NextResponse.json(
        { text: replyText, toolsUsed, weather: lastWeather, tours: matchedTours },
        { headers }
      );
    }

    return NextResponse.json(
      { error: "Too many tool-calling turns without a final answer." },
      { status: 500, headers }
    );
  } catch (err) {
    console.error("Gemini request failed:", err);
    return NextResponse.json(
      { error: "Failed to get a response from Gemini." },
      { status: 502, headers }
    );
  }
}
