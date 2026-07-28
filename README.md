# Customer Engagement AI (CA2)

A Next.js chatbot that uses Google Gemini as its "brain," deployed on Vercel.

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the env example and add your Gemini API key:

   ```bash
   cp .env.example .env.local
   ```

   Then set `GEMINI_API_KEY` in `.env.local`. Get a key from [Google AI Studio](https://aistudio.google.com/apikey).

3. Run the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Project structure

- [`src/app/api/chat/route.ts`](src/app/api/chat/route.ts) — server-side API route that calls the Gemini API. The key never reaches the browser.
- [`src/app/page.tsx`](src/app/page.tsx) — chat UI.

## Deploying to Vercel

1. Push this repo to GitHub (already wired to `origin`).
2. Import the repo in [Vercel](https://vercel.com/new).
3. Add an environment variable `GEMINI_API_KEY` in the Vercel project settings (Production/Preview/Development) with your key.
4. Deploy.
