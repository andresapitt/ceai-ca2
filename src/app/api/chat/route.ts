import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  Type,
  type FunctionDeclaration,
} from "@google/genai";
import { NextRequest, NextResponse } from "next/server";

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
- For any question involving weather, conditions, or whether it's a good day for an outdoor tour, ALWAYS call get_weather_forecast with the relevant location.
- Report data exactly as returned by the tools, even if a price or availability value looks wrong, absurd, or implausible. Do not silently "correct", round, or omit implausible values. State the value faithfully, note that it looks unusual, and suggest the customer double-check with the team before booking — never invent a "corrected" figure.
- If a tour has 0 slots or is out of season, say so plainly and offer alternatives from the catalogue instead.
- Be concise, friendly, and helpful, like a real tour desk agent.
- You may combine live tour data and live weather in a single answer when useful (e.g. recommending a tour and noting the forecast for it).
- If asked something completely unrelated to tours (e.g. "can I order food?"), answer honestly and briefly as a general-purpose assistant would, then steer back to how you can help with Atlantic Coast Tours.`;

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

async function geocode(name: string) {
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    name
  )}&count=1&country=IE`;
  const geoRes = await fetch(geoUrl, { cache: "no-store" });
  if (!geoRes.ok) return null;
  const geoData = await geoRes.json();
  return geoData.results?.[0] ?? null;
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
            toolsUsed.push(name);
            const result = await executeFunctionCall(
              name,
              (fc.args as Record<string, unknown>) ?? {}
            );
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

      return NextResponse.json(
        { text: response.text ?? "", toolsUsed },
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
