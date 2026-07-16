# CapacIQ

L&D Resource Planning & Deadline Governance system for Dermorepubliq.
Replaces the Notion project tracker — see `/docs` in the project folder
for the full requirements brief.

## Stack
- React + React Router (Vite) — static build, hosted on GitHub Pages
- Supabase (Postgres + Auth) — see `supabase/schema.sql` for the initial schema

## Local setup
```
npm install
cp .env.example .env.local   # fill in your Supabase project URL + anon key
npm run dev
```

## Notes
- No CDN `<script>` tags (jsdelivr, unpkg, etc.) anywhere in this app —
  everything is bundled locally by Vite. This is intentional: some of the
  team hits a CDN block on Edge over the corporate network.
- Dates: `original_due_date` is locked forever; `current_due_date` only
  moves through an approved row in `extension_requests`.
