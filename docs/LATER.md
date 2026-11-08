# Later

- `npm run db:migrate` exits 1 without a message until the first `npm run db:generate` creates
  `drizzle/meta/_journal.json` (drizzle-kit hides "Can't find meta/_journal.json file" behind its spinner).
- Vercel still holds prototype variables `LOCAL_DEMO`, `BOOTSTRAP_OWNER_ID`, `BOOTSTRAP_OWNER_EMAIL` and
  `NEXT_PUBLIC_APP_URL`; remove them once confirmed unused.
