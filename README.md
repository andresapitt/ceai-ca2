# Atlantic Coast Tours — Customer Assistant (CA2)

A customer-support chatbot for Atlantic Coast Tours, with a Gemini language-model brain and two live tools:

- **Google Sheet tour catalogue** — read live at question-time via Google's public `gviz` JSON endpoint, no caching.
- **Open-Meteo weather** — live forecast for a named location, via geocoding + forecast API.

## Architecture

Two pieces, on purpose:

- **Backend** — Next.js API route (`src/app/api/chat/route.ts`), deployed on Vercel. Holds `GEMINI_API_KEY` server-side, runs the Gemini function-calling loop, executes the two live tools.
- **Frontend** — a plain static page (`docs/index.html`), deployed on **GitHub Pages** (submission requirement). It calls the Vercel backend over `fetch`, so the Gemini key is never present in the deployed static site.

The Next.js page (`src/app/page.tsx`) is a duplicate same-origin test console — handy for local development.

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the env example and add your Gemini API key:

   ```bash
   cp .env.example .env.local
   ```

   Set `GEMINI_API_KEY` (from [Google AI Studio](https://aistudio.google.com/apikey)) and `ALLOWED_ORIGIN` (your GitHub Pages origin, e.g. `https://andresapitt.github.io`).

3. Run the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) to test via the same-origin Next.js page.

## Deploying

**Backend (Vercel)**
1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. Project Settings → Environment Variables: add `GEMINI_API_KEY` and `ALLOWED_ORIGIN` (all environments).
3. Deploy / redeploy after adding variables.

**Frontend (GitHub Pages)**
1. Repo Settings → Pages → Source: "Deploy from a branch".
2. Branch: `main`, folder: `/docs`.
3. Save — live at `https://<username>.github.io/<repo>/`.

`docs/index.html` points at the production Vercel URL via `API_URL` — update that constant if the Vercel domain changes.
