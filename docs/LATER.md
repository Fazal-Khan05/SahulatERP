# Later

Things noticed while building a step that belong to a later one, or to nobody yet.

## From Step 2

- **Member management has no screen.** An owner can invite, but cannot change a member's role or
  branches, deactivate a member or cancel an invitation. `app_runtime` has no UPDATE on
  `memberships` or `invitations` yet; the screen needs a migration that grants and polices it.
- **Invitations are sent by hand.** An owner's invitation is recorded in the app and sent when
  someone runs `npm run invites:send` on a machine that holds the service-role key. The worker
  exists since Step 4; make sending an invitation a job kind once the worker runs somewhere
  permanent (`scripts/lib/invitations.mjs` is written to be called from a handler).
- **Someone who already has an account cannot be invited into another company yet.** The
  invitation is recorded but stays waiting: `invites:send` never adds an existing account to a
  company without that person's consent (an owner could otherwise attach anyone to their company
  by knowing an email address). It needs an accept step in the app. Decide then whether a sign-in
  is written to every company the person belongs to, as now, or only to the one they open.
- **Auth emails need a custom SMTP provider before real customers.** On the free plan with
  Supabase's own sender: emails go only to addresses on the Supabase team, about two an hour, and
  the email templates cannot be edited (the Management API refuses). So invite and reset links use
  Supabase's default style: Supabase checks the one-time token when the link is opened and passes
  the session to `/auth/confirm` in the address fragment. With custom SMTP, switch the templates to
  token-hash links and add a confirm button, so a mail scanner that opens the link first cannot
  use it up.
- **`service_role` still has every privilege on public tables** (Supabase's default; it also
  bypasses row-level security). Nothing uses the Data API for application tables, so these grants
  can be revoked and the public schema taken off the Data API.
- **CI does not run the database or browser tests.** `npm run check` skips the policy tests when
  the database URLs are absent, and CI does not run `npm run test:e2e`. Both need a database CI
  can use; today they run locally against the dev project.
- **Preview deployments use the dev database**, the same one as production while building.
- **Pages are slow because of distance to the database, not because of the queries.** The
  database is in Mumbai (ap-south-1); Vercel runs the functions in Washington (iad1), and from the
  founder's Mac one round trip measured 200 to 450 ms. A transaction costs a round trip each for
  begin, the request context and commit, and every query with parameters costs two (the pooler
  needs `prepare: false`). Step 3 cut the frame of every page to about five round trips, but a
  page still makes ten or more. Move the function region to Mumbai (bom1); the rest belongs to the
  Step 50 performance pass.
- **`memberships.user_id` has no foreign key to `auth.users`.** Deliberate: it keeps the app's
  tables independent of Supabase's schema for exports and restores. Revisit with Step 48.
- **Dates are shown in Pakistan time** (`src/lib/format.ts`) until a tenant can choose a time zone.
- **Choosing a new password does not ask for the old one** when already signed in. Step 47
  (password policy, session timeout, 2FA) should require a recent sign-in.
- **A session that was ended elsewhere keeps working until its token expires** (up to an hour):
  requests verify the token's signature, not whether Supabase still lists the session.
  Deactivating a membership takes effect at once, because the database checks it on every query.
  Also for Step 47.
- **The forgot-password form has no limit of its own.** Supabase limits reset emails per address
  and per project; on the free sender a few requests use up the hour's quota for everyone.

## From Step 3

- **The shell was built from the mock-ups as they stand.** `docs/UI-NOTES.md` has no reviewer
  comments yet; the founder asked for Step 3 to start anyway. What the reviews change will have to
  be changed in the shell (`src/app/(app)/layout.tsx`, `navFor` in `src/modules/tenant/rules.ts`).
- **Three roles have no mock-up.** The menus for Sales Manager, Payroll Administrator and Auditor,
  the module list, which modules start on (payroll and FBR start off) and the dependency rules
  between modules are a first proposal in `rules.ts`; the founder should check them.
- **Menu entries for screens that are not built are shown greyed, not as links.** The step that
  builds a screen gives its entry an address in `roleNav` (`rules.ts`).
- **Every role's home is the same placeholder** (who you are, an empty "Needs attention"). Each
  role's own figures arrive with the modules that produce them.
- **The logo is stored in the `settings` row** (PNG, JPEG or WebP, 256 KB at most). The `files`
  table exists since Step 4, but only owners and auditors may read files and every member needs
  the logo, so it stays here until file access is widened; `/branding/logo` can keep its address.
- **`settings.fbr_enabled` from the data-model table is the `fbr` module switch**, a row in
  `modules_enabled`, not a column. Step 43 should read that.
- **The dependency rules are checked by the command, not by the database.** Two owners switching
  modules in the same instant could leave a module on without one it needs.
- **The inbox has no rows and no table yet.** The first step that produces something to act on
  decides how items are stored or derived.

## From Step 4

- **The worker is started by hand** with `npm run worker` on a machine that has
  `MIGRATION_DATABASE_URL`. Nothing runs jobs on Vercel. It gets a permanent home with the Railway
  service in Step 51; until then a queued job waits for someone to start the worker.
- **The worker is plain JavaScript** (`scripts/lib/worker.mjs`), so it cannot import the
  TypeScript modules. The first job that needs business rules (the FBR submission, a report)
  needs the worker built or run with a TypeScript loader; decide then, with the founder, since a
  loader is a new dependency.
- **Only one kind of job exists: `system.ping`**, which does nothing. Each step that needs
  background work adds its kind to `JOB_KINDS` (`src/modules/jobs/rules.ts`) and its handler to
  `scripts/lib/job-handlers.mjs`. A handler must be safe to run twice.
- **Dead jobs are not shown anywhere.** A job that fails five times is marked dead and stays in
  the table. The inbox ("FBR submissions failed") is where they should surface.
- **Files are capped at 4 MB and go through the app.** Larger scans need a direct upload to the
  object store with a signed upload link; do it with the move to R2.
- **Only owners add files, and only owners and auditors read them**, in the database and in
  Supabase Storage alike. Steps that attach files to documents must widen both.
- **Files cannot be renamed or deleted, and an upload that fails leaves a "pending" row** that is
  never listed. A clean-up job for old pending rows belongs with the nightly jobs.
- **The `authenticated` role can now reach the `app` schema**, because Supabase Storage's policies
  call `app.storage_role`. Every other function there has its EXECUTE revoked from PUBLIC, and a
  test fails if a later one does not. A new function in `app` must `REVOKE ALL ... FROM PUBLIC`.
- **An owner talking to Supabase Storage directly can create any object name inside their own
  company's folder**, not only `<company id>/<file id>`. It stays inside their company; tighten
  the storage policy to that exact shape when the policies are next changed.
- **The move to R2** is a second implementation of `ObjectStore` in `src/lib/storage/` plus
  copying the objects; keys (`<company id>/<file id>`) stay the same.
- **The database tests take about three minutes locally** and run one file at a time, because of
  the distance to the database. CI skips them.

## From Step 5

- **The base currency is chosen on the Currencies screen**, by the owner, the first time they open
  it. The setup wizard (Step 11) should ask for it during setup with the same command
  (`setBaseCurrency`), so no company reaches its first document without one.
- **A currency cannot be renamed, archived or removed once added**, and the base currency can
  never change: the app has no UPDATE or DELETE on `currencies`. If a wrong code is added it just
  stays unused. Add archiving with the pattern Step 7 sets for customers.
- **Rates are typed in by hand.** Nothing fetches them. A daily rate from the State Bank or a
  bank's feed would be a job for the worker.
- **A lookup returns nothing when a currency has no rate on or before the date.** The first
  document in a foreign currency (Step 22) must refuse to guess, and should decide whether a rate
  that is many days old needs a warning.
- **How a converted amount is rounded is not decided yet.** Rates keep eight decimals and money
  four; the rounding rule belongs with the first step that converts an amount, checked by the
  accountant.
- **Every member can read currencies and rates in the database**, because any document in a
  foreign currency will need them; the screen itself is for the owner, accountant and auditor.
- **The accountant's menu has "Exchange rates"**, which opens the Currencies tab in Settings.
  It is not in the Step 1 mock-up.

## From Step 6

- **The starting tax rows are not yet checked by an accountant.** `docs/RATES-REVIEW.md` lists
  every value with its source and four open questions (further tax on Third Schedule and
  zero-rated goods, the Khyber Pakhtunkhwa section, what the pilot needs from day one). The
  founder takes it to the pilot company's accountant; the launch gate needs the sign-off.
- **Every starting row is dated 1 July 2026.** A document dated earlier finds no rate, and the
  lookup returns nothing rather than guess. If the pilot's old documents are entered with tax
  (Step 49), rows for the earlier period must be added first.
- **A change in the law reaches companies in two ways.** We ship a migration that adds the new
  dated row for every company and updates `app.seed_tax_defaults` for new ones; or a company's own
  owner or accountant adds the row on Settings, Tax. If both happen for the same date, the
  company's row stays (the migration must use `ON CONFLICT DO NOTHING`, as the seed does).
- **Only the rate tables exist.** Who attracts further tax, which supplies SRO 648(I)/2013
  excludes, the retail-price base for Third Schedule goods and the sale type code are the tax
  engine's (Step 17). Which withholding line a supplier bill uses, the section 153 thresholds
  (Rs 75,000 goods, Rs 30,000 services a year), who must deduct, and the Eleventh Schedule's
  exclusions are the supplier bill's (Step 25). Step 25 picks a line by its code, such as
  `income_tax.goods.company`; the codes are the fixed vocabulary in the seed.
- **Which sales tax withholding lines apply depends on what the company itself is** (a company,
  or an individual or AOP; registered or not). The setup wizard (Step 11) asks for the tax
  registration status; nothing stores the company's own type yet.
- **How much provincial sales tax the buyer withholds is not in the tables**, only each
  province's standard rate. The shares differ by province and Punjab's published rules contradict
  each other; `docs/RATES-REVIEW.md` has what was found. Needed by Steps 25 and 34.
- **Lines left out of the starting rows** (reduced rates, special section 153 lines such as the
  0.25% for distributors, other Eleventh Schedule lines, Islamabad, extra tax, federal excise) are
  listed in `docs/RATES-REVIEW.md` under "Not included".
- **A company can add a sales tax category but not a withholding line.** A new withholding line,
  or a change to a line's wording or to what its percentage is taken of, needs a migration.
- **A category cannot be renamed, archived or removed**, like a currency. Add archiving with the
  pattern Step 7 sets.
- **The starting rows can be corrected by an owner or an accountant** (a second rate for the same
  date replaces the first; the audit log keeps both). Decide before launch whether the rows we
  ship should be locked against that.
- **Rows we seed are recorded as created by the person who created the company.** Nothing marks a
  row as ours rather than typed in; the audit log shows only the rows a member changed.
- **The withholding lists are in code order, not the law's order** (contracts before goods).
  A display order column would fix it.
- **The accountant's menu has "Tax rates"**, which opens the Tax tab in Settings. It is not in the
  Step 1 mock-up.
- **`isIsoDate` and `formatIsoDate` live in the currencies rules** and the tax module borrows
  them. Move them to `src/lib` when a third module needs them.
- **Database changes held for the migration that follows the accountant's answers**, so the
  founder is asked once. None changes a rate; the app already enforces the first two.
  (1) Only an income tax line may carry a second rate for suppliers not on the Active Taxpayers
  List, and it must carry one: a CHECK on `withholding_rules`. (2) Category names unique whatever
  their capitals: an index on `lower(name)`, as branches have. (3) The seeded wording: the Third
  Schedule row states SRO 648(I)/2013 as settled and the zero-rated row cites no basis for its
  zero further tax; the listed-services line names five of about thirty sectors; the
  independent-professionals line omits software developers; the two active-taxpayer sales tax
  lines do not say they apply only to a buyer that is not registered. (4) The trigger on
  `tax_rates` runs before the row-level check, so its error text can tell someone writing raw SQL
  as `app_runtime` the kind of another company's category; it also passes a row whose category
  it cannot find (the foreign key then refuses it). (5) The seed matches a rate to its category by
  name only.
- **The supplier bill must show the full list of the 7% service sectors** where the line is
  chosen (Step 25); the line's own wording is too short for it.
- **Two people correcting the same date's rate at the same moment** now wait for each other, so
  each audit row records the value it really replaced. Step 5's `setRate` for exchange rates does
  not do this yet.
- **The Activity screen shows only the new values of a change**, and leaves out anything empty.
  The audit row itself holds the old and new values.

## From Step 7

- **A customer or supplier has one contact and one address on its screen.** The `contacts` and
  `party_addresses` tables can hold more (one is marked primary); the screens for more than one
  arrive with the documents that need them, such as a delivery address on an order.
- **`customers.price_list_id` has no foreign key and no field on the screen.** Step 9 creates
  price lists, adds the foreign key and the column grant, and puts the choice on the customer.
- **The customer class is free text.** Two spellings are two classes. Step 9 prices by class, so
  it should turn the classes in use into a list to pick from.
- **A salesperson's "My customers" shows every customer.** Nothing ties a customer to a
  salesperson yet; that comes with commissions and assignments (Steps 18 and 37). Salespeople can
  read customers but not add them.
- **Recovery officers and warehouse managers can read their list but have no menu entry for it.**
  Recovery officers read customers and warehouse managers read suppliers, in the database and by
  address (`/customers`, `/suppliers`); their menus get an entry when their own screens need one.
- **The Active Taxpayers List status is typed in by hand.** The time it was last changed is kept
  as the time it was checked. The automatic check against FBR is Step 45.
- **The credit limit is only stored.** Checking an order against it, with the owner's override,
  is Step 18; a customer's balance does not exist yet.
- **Names must be unique within customers and within suppliers**, whatever the capitals, and an
  archived party still holds its name and code. Two real parties with the same name need
  something added to tell them apart, such as the city.
- **Import adds only.** It cannot update customers that already exist; a file that names one is
  refused. Updating from a file, and a file to download as a starting point, would help the
  migration from Fast Accounts (Step 49).
- **Import reads comma-separated UTF-8 files up to 2,000 rows.** Excel's "CSV UTF-8" works. A
  file in an older encoding is refused with that advice when it holds any accented letter; a
  semicolon-separated file is refused as having unknown columns.
- **Lists show the first 200 and ask the reader to search.** Paging, sorting, a column chooser and
  export (UI principle 8) are not built; the same pattern will serve every list.
- **A supplier has no default currency or bank details.** Purchase orders in a foreign currency
  (Step 24) and supplier payments (Step 26) will want them.
- **Phone numbers and CNICs are in the audit log** when a party is created or one of those fields
  changes, readable by the owner and the auditor. Nothing writes them to the server's logs.
- **Amounts are shown with lakh and crore grouping by `formatAmount` in `src/lib/money.ts`**, and
  `parseAmount` reads them without commas. Later screens should use these.
- **A module that is off closes the customer or supplier screens and their forms, not the data.**
  Customers go with Sales and suppliers with Purchases: the menu entry leaves, the screens say the
  module is off and the actions refuse. The commands and the database policies do not look at the
  module switches.
- **Database tightening held for the next migration that touches these tables** (Step 9 adds the
  price list foreign key). The policies do not pin `archived_by` to the person archiving, and an
  insert may set `price_list_id` or `created_at`; only the app holds the role that could, and the
  app never does.
- **A form opened before someone else's change is refused on save**, with a message to reload.
  The same guard belongs on every edit form to come.
- **An imported party has no audit row of its own.** The import's one audit row lists the ids of
  everything it made.
- **A search travels in the page address** (`/customers?q=...`), so a phone number searched for
  can sit in the hosting platform's request logs. The app's own logs never hold it.
- **A registered party needs an NTN, an STRN or a CNIC.** Check with the accountant whether a
  registered buyer can be recorded on a CNIC alone.
- **Imports that overlap can deadlock.** Two people importing files that share names in a
  different order: one gets "That did not work. Please try again." and nothing of theirs is kept.
- **The local throwaway database must be created as UTF-8** (`initdb -E UTF8`); otherwise names
  outside ASCII are counted and compared differently from Supabase.

## Decided by the founder on 2026-11-13

- **No accountant.** Claude does the accounting checks; see "Accounting checks" in
  `docs/PROMPTS.md`. Issues found later are debugged then.
- **The merchant is responsible for its tax rates.** New companies get the starting rates; the
  setup wizard (Step 11) shows them and has the owner tick that they were checked. The terms of
  service (launch gate) say the same.
- **A company that is not registered for sales tax sees no tax anywhere.** The wizard (Step 11)
  asks once; invoices then show item, quantity, price and total only, and the tax engine
  (Step 17) charges nothing. This is the usual case for the first customers.
- **Prices can include tax.** A registered merchant types the final price and the product works
  the tax out of it (for 18%, the price divided by 1.18), still showing the tax on the invoice as
  the law requires. Needed in the tax engine and the sales documents (Steps 17 to 20); the plan's
  text does not mention it.
- **Recommended options are accepted without asking** while the founder is away, including
  applying additive migrations to the dev database and pushing a step once every check passes.
  Anything destructive, or a choice with no clear recommendation, still waits for him.


## From Step 8

- **An item is counted in one unit and that unit can never change**, because stock will be kept
  in it. A wrong unit means archiving the item and adding it again.
- **Only `toBaseQuantity` (`src/modules/items/rules.ts`) converts a quantity**, and
  `convertToBase` is what a document line calls with the stored conversions. It refuses a result
  that four decimals cannot hold exactly; nothing is rounded. Sales and purchase lines (Steps 18
  and 24) must store both what was entered (quantity and unit) and the base quantity.
- **Correcting a pack size affects only lines entered afterwards.** Lines already written keep
  their own base quantities. Once stock exists, changing or removing a unit should warn.
- **An item has no price yet except the printed retail price.** The default selling price and
  price lists are Step 9; cost comes from purchases (Step 24).
- **Categories are a flat list** and units and categories cannot be renamed or removed. Add
  archiving and a category tree if a customer needs them.
- **The tax category on an item may be left empty.** The tax engine (Step 17) decides what an
  item with none is charged; a company not registered for sales tax never needs one.
- **HS code, FBR unit code and sale type are stored as typed.** The FBR module (Phase 7) should
  offer FBR's own lists to pick from.
- **Batch and serial tracking are switches only.** Nothing uses them until Phase 9.
- **Only an owner or an accountant changes items.** A warehouse manager reads them. Widen it if
  the pilot's storekeeper keeps the item list.
- **Import matches units, categories and tax categories by name and never creates them.** It adds
  items only; it cannot update items that exist. One pack unit per row.
- **The party import and the item import read files with two copies of the same logic**
  (`src/modules/parties/rules.ts` and `src/lib/csv-table.ts`). Move the party import onto
  `readCsvTable` when it is next touched.
- **Weight is in kilograms and volume in cubic metres**, per one of the item's own unit, for
  spreading freight over a shipment (Step 28).
- **Nothing calls `convertToBase` yet**: the conversion is proved by tests until documents exist.
  The posting engine will need the same lookup inside its own transaction, and must decide
  whether a line may use an archived item.
- **The policy on `items` does not pin `archived_by` to the person archiving**, as on customers
  and suppliers; held for the next migration that touches these tables.
- **A save that does not say which version it was loaded from is not checked for staleness.**
  The screens always say; a hand-made request need not.

## From Step 9

- **A price is for one of the item's own unit.** A line entered in cartons needs the price times
  the carton's size; the sales order (Step 18) does that with `convertToBase`'s factor.
- **`getPriceFor` (`src/modules/prices/queries.ts`) is what a sales line calls**: the customer's
  own price, else the class price, else the customer's list or the default list, else the item's
  selling price. It returns nothing when no level has a price; the line must then ask for one.
  A salesperson overriding the price on a line, and who may, is Step 18's decision.
- **Prices do not say whether they include tax.** The founder decided prices can include tax;
  the tax engine and sales documents (Steps 17 to 20) need a company-wide or per-list switch.
- **Prices are in the company's base currency only.** A price list in another currency waits for
  multi-currency sales (Step 22).
- **A price is ended by giving it a last day; it cannot be deleted**, and a price list cannot be
  renamed or archived. Saving a price that starts the same day corrects it.
- **Class prices match the customer's class by its text**, whatever the capitals. The class is
  still free text on the customer (see Step 7's note); a list of classes to pick from would stop
  misspellings from silently missing their price.
- **Prices are typed one at a time.** Importing a price list from a file would help the pilot's
  migration (Step 49).
- **A sales manager can set prices but not an item's selling price**, which sits on the item and
  follows the item's rule (owner or accountant).
- **The warehouse manager reads items, including the selling price, but no price lists or special
  prices.**
- **A customer price is given by the customer's code or exact name.** Where one customer's code
  is another's name, the code wins. A picker that searches customers would remove the question.
- **A comment in `drizzle/0007_prices.sql` says the warehouse has no business with prices**, yet
  a warehouse manager reads an item's selling price, which sits on the item. The migration is
  applied and cannot be edited; the sentence above is the accurate one.

## From Step 10

- **`takeDocumentNumber` (`src/modules/numbering/commands.ts`) is how a document gets its
  number**, inside the transaction that writes it. It asks the database function
  `app.next_document_number`; nothing in the app computes a number. The posting engine (Step 13)
  and every document step call it at the moment a document is submitted, not when a draft is
  saved, so drafts that are thrown away leave no gap.
- **A document's date must fall in an open, unlocked fiscal period** or it gets no number. The
  posting engine must make the same check for journals that carry no document number.
- **Numbers look like SI-2627-00001** (kind, fiscal year, counter), chosen by the founder. The
  letters for each kind are fixed in `DOCUMENT_TYPES` (`src/modules/numbering/rules.ts`); a company
  cannot change them. The counter grows past five digits rather than wrap.
- **The fiscal year's first month is chosen once**, when the first year is opened; every later
  year follows the last. Periods are whole calendar months. A short first year or a change of
  year-end is not supported.
- **Locking a period stops new document numbers in it.** It does not yet stop edits to drafts or
  postings without a number; Step 13 enforces the lock on journals.
- **Only an owner opens a fiscal year, locks or unlocks a period, or adds a warehouse.** An
  accountant reads the periods and counters.
- **Warehouses and branches cannot be renamed, archived or removed.** A warehouse belongs to one
  branch, and members limited to some branches see only those branches' warehouses.
- **Nobody is reminded to open the next fiscal year.** On the first day of an unopened year no
  document can be numbered. The inbox ("Needs attention") should warn the owner a month ahead.
- **For the posting engine (Step 13), from the review of the number function:** a transaction
  that takes numbers for two kinds of document must always take them in the same order, or two
  such transactions can deadlock (one is rolled back; no number is lost). A caller running at
  REPEATABLE READ or SERIALIZABLE gets a serialization failure under contention and must retry;
  the app runs at READ COMMITTED. Nothing yet ties a taken number to a document row: the
  document tables should carry a unique document number per company.
- **The first fiscal year cannot be moved once opened.** It must start within two years before
  or one year after today; a wrong one needs the database's undo script.
- **The Fiscal periods screen shows each counter's next number formatted by the app** (display
  only); the number a document gets always comes from the database function.

## From Step 11

- **A new company lands on the setup wizard** (`/setup`) and its owner is reminded on Home until
  it is finished. Nothing else is blocked while setup is unfinished; once documents exist they
  should refuse to post until the company is set up.
- **The wizard's parts are done one after another, each by its own module's command**, not in
  one transaction. If it stops half-way, submitting again finishes the rest; what was done stays.
  The record in `company_setup` is what marks a company as set up.
- **The recorded answers are a record of what was asked, not the source of truth for the parts
  other modules own.** The base currency, fiscal year, modules, branches and warehouses are read
  from their own tables. `company_setup` is the source of truth only for the sales tax
  registration, the company's own NTN and STRN, and the chosen chart of accounts.
- **`getCompanySetup(ctx).salesTaxRegistered` is what the tax engine (Step 17) and every sales
  screen must read**: not registered means no tax is charged or shown anywhere.
- **The setup answers cannot be changed afterwards.** A company that registers for sales tax
  later needs a screen (and a dated record) to say so; decide with the tax engine.
- **The chart of accounts is only chosen, not created.** Step 12 creates the accounts from
  `accountsTemplate` ("trading" is the only one) for companies that are set up, and at setup
  from then on.
- **The owner ticks that the tax rates were checked** only when registered; the moment is kept
  in `tax_rates_confirmed_at`. The terms of service should say the company is responsible for
  its rates (launch gate).
- **Module bundles are a starting point** (Trading; Trading with imports; Everything). Each
  switch can still be changed under Settings, Modules.
- **Nothing is assumed about sales tax registration**: the wizard makes the owner choose. A
  company's own NTN must be 7 digits; a sole proprietor who uses a 13-digit CNIC as the NTN
  cannot enter it there yet.
- **One submission of the wizard runs at a time per company** (`withSetupLock`), and everything
  is checked before the first write, because the base currency and the fiscal year cannot be
  undone. The lock holds one database connection while the steps use others.
- **The wizard sets every module to the chosen bundle**, including one switched on by hand before
  setup was finished.
