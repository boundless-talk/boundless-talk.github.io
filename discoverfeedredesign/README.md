# Discover Feed redesign (prototype)

Implementation of the "Boundless Talk — Discover Feed" design handoff from Claude Design
(intro screen + Discover feed, option 1a: grid dashboard), built as a standalone React +
Vite + Tailwind app.

**Status: front-end prototype only.** This is not wired to the production Firebase Auth,
Realtime Database, or Agora RTC backend that the live site (`index.html` at the repo root)
uses — room data is a static fixture (`src/data/rooms.ts`). It's meant for design review,
not to replace the running service.

## What's here

- Intro / splash screen with logo, tagline, and Start listening / How it works actions.
- Discover feed (grid dashboard layout): category filter, trending tags, live room cards
  with a 4-node presence ring, animated waveform, and a live pulse badge.
- A global Dark / Cute theme toggle, persisted to `localStorage`, shared across both screens.

## Running locally

```bash
npm install
npm run dev
```
