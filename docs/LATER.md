# Later

- `npm run db:migrate` exits 1 without a message until the first `npm run db:generate` creates
  `drizzle/meta/_journal.json` (drizzle-kit hides "Can't find meta/_journal.json file" behind its spinner).
