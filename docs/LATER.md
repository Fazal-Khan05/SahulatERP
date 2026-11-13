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
- **Reports download as real Excel files** (decided 2026-11-13): the library `write-excel-file`
  was approved for it. It is used on the server only.
- **One switch per company says whether its prices include sales tax** (decided 2026-11-13),
  asked at setup of a company registered for sales tax. Not per price list, not per invoice.
- **An item with no tax category is charged the standard rate** at a company registered for
  sales tax (decided 2026-11-13). The invoice shows the tax, so a wrong one is seen and put
  right on the item.
- **A salesperson may change a price or give a discount on their own** (decided 2026-11-13).
  The document shows the list price beside the price charged, and the audit log keeps who
  charged what. A cap on the discount can be added later; nothing limits it now.
- **Stock never goes below zero** (decided 2026-11-13). A delivery that asks for more than the
  system shows in stock is refused; the stock is entered first.
- **Salespeople may issue sales invoices** (decided 2026-11-13), as may the owner, an
  accountant and a sales manager. Every invoice is logged.
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
- **The wizard creates the chart of accounts it asks about** (since Step 12). A company set up
  before that gets a button on Settings, Accounts.
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

## From Step 12

- **The chart of accounts was designed by Claude, not by an accountant** (see "Decided by the
  founder on 2026-11-13"). It is a standard chart for a trading company: 65 accounts under
  Assets, Liabilities, Equity, Income and Expenses, written by `app.seed_accounts`
  (`drizzle/0011_accounts.sql`).
- **A posting finds its account by what the account is for (`control_type`), never by a code or a
  name.** The vocabulary is `CONTROL_TYPES` in `src/modules/ledger/rules.ts`. Every account a
  later step posts to by itself is locked from the start: receivables, payables, stock, goods in
  transit, goods received not invoiced, cheques in hand, advances to suppliers and from customers,
  the tax accounts, salaries and commission (expense and payable), bank charges, exchange gain or
  loss, stock adjustments, sales, cost of goods sold, retained earnings and opening balance
  equity. A step that finds it needs one more must add it by migration for every company, and
  must pick a code and a name no company has taken (both are unique per company): check before
  inserting, and fall back to a free code.
- **The company's own bank and cash accounts are ordinary accounts under the locked headings
  "Bank accounts" and "Cash accounts"**, and carry `bank` or `cash`. A heading added under them
  carries it too, so a lookup for bank accounts must leave out headings. Cash and bank (Step 33)
  should tie its `bank_accounts` rows to these.
- **Only an owner, an accountant or an auditor can read accounts.** A salesperson submitting an
  invoice cannot; the posting engine (Step 13) finds accounts inside the database function, with
  the table owner's rights.
- **A company not registered for sales tax does not see the three sales tax accounts** (input
  tax, output tax, sales tax withheld) on its chart; they exist and stay empty. The withholding
  accounts for income tax and provincial sales tax are shown: a company can be a withholding
  agent without being registered for sales tax.
- **A locked account cannot be renamed**, even to another language or the company's own word for
  it. If that is wanted, add a display name beside the locked name.
- **An account cannot be moved to another heading or change type.** A wrong one is deleted while
  nothing uses it, or archived and added again.
- **An archived account still holds its name and code.** Adding one with the same name says so.
- **Deleting an account with postings is refused by the foreign key from journal lines**, which
  arrives with Step 13; the test for it is in that step.
- **Year-end close is not built.** Retained earnings is locked and ready; the reports (Step 16)
  work the year's profit out from income and expenses.
- **Accounts the chart leaves out on purpose:** sales returns and discounts (the sales documents
  in Steps 19 and 20 decide whether they need their own), purchase price differences, rounding,
  federal excise, and one account per fixed asset class for accumulated depreciation.
- **The suggested code for a new account** follows the last account under its heading and never
  reaches the next heading; a company can always type its own.

## From Step 13

- **`postJournal(tx, source, lines)` in `src/modules/ledger/posting.ts` is the only way a journal
  is written.** It runs inside the transaction of the command that needs it and calls the
  database function `app.post_journal`; the app has no INSERT, UPDATE or DELETE on `journals` or
  `journal_lines`. `reverseJournal(tx, journalId, { date })` is the only way one is undone.
  `docs/examples/step-13.md` has a worked example, checked by Claude, not by an accountant.
- **A step that adds a kind of document that posts** adds it in two places that must agree: the
  three small database functions `app.journal_source_roles` (who may post it),
  `app.journal_source_reversal_roles` (who may reverse its journal directly; nobody, for a
  document that must be cancelled through its own command so that its own records are undone
  with the journal) and `app.journal_source_blocked_controls` (accounts it may not touch), and
  `JOURNAL_SOURCES` in `src/modules/ledger/rules.ts`. A test fails if the two differ. Only
  `manual_journal` exists.
- **A manual journal cannot post to the accounts that must agree with records kept elsewhere**:
  receivables, payables, advances to suppliers and from customers, stock, goods in transit, goods
  received not invoiced, cheques in hand. It can still post to the other locked accounts: the
  tax and withholding accounts, salaries and commission (expense and payable), retained earnings
  and opening balance equity. That is on purpose for now: a company with no payroll module books
  salaries by journal, and paying sales tax to FBR has no document of its own yet. Each step that
  builds the records behind one of those accounts (commissions in Steps 38 to 41, payroll, the
  tax returns) should decide whether to close it to manual journals, by adding it to
  `app.journal_source_blocked_controls`. Closing it later is safe; journals already posted stay.
- **A line on receivables or advances from customers names its customer, and a line on payables
  or advances to suppliers its supplier.** The database refuses one that does not. So a
  customer's or supplier's balance is the sum of the journal lines that name them; statements and
  ageing (Steps 31 and 32) can be built on that.
- **Journal lines are in the company's base currency only.** A document in a foreign currency
  (Step 22) posts base amounts; if it needs the foreign amount on the line (for revaluation),
  that is new columns, added before the first such line is written.
- **`journal_lines.cost_centre_id` exists and must be empty.** The database refuses any value
  until cost centres exist, because a line can never be corrected. The step that adds cost
  centres drops the check `journal_lines_no_cost_centre_yet`, adds the foreign key, and lets
  `app.post_journal` store the value.
- **A journal belongs to a branch or to the whole company.** Its lines carry the same branch, for
  the branch filter on reports (Step 16). A member limited to some branches posts to, sees and
  reverses only those branches' journals, never the company-wide ones.
- **A journal's document number is unique in the company, and a reversal has none.** A reversal
  is found by the journal it reverses; a screen shows it as "Reversal of JV-2627-00001".
- **A reversal cannot itself be reversed.** A journal reversed by mistake is posted again as a
  new document.
- **A journal has at most 1,000 lines.** The balance check at the end of the transaction adds
  the journal up once per line, which is about a quarter of a second for 1,000 lines. A document
  that needs more (a large opening balance, a payroll run for hundreds of people) should post
  several journals, or the check should be made to run once per journal.
- **An account can be archived in the same instant a journal posts to it.** Both are kept. The
  journal is valid; the account just holds one more line than it had when it was archived.
- **Removing a whole company's journals is possible only for a session signed in as postgres**
  that names the company in `app.purge_tenants` for that transaction. The tests use it. Deleting
  a real company's data (launch gate) should go through one audited operator script that does
  this, never by hand.
- **The dev database is also production while building**, so the 1,000 test journals the engine
  test posts are written to it and removed again each run.
- **The engine writes its own audit row** (`journal.post`, `journal.reverse`) inside the database
  function, so no journal exists without one. The command that asked for the journal writes its
  own row as well.
- **The fiscal-period messages are shared**: `periodRefusal` in `src/modules/numbering/rules.ts`
  turns the database's SE001 and SE002 into the same words wherever a date is refused.

## From Step 14

- **A manual journal is a document of its own** (`manual_journals`, `manual_journal_lines`), not a
  row in the ledger. A draft can be changed and thrown away and need not balance. Posting it
  takes its number (JV-2627-00001) and posts one journal through the engine; from then on the
  document and its lines never change. The plan's data model lists no such table; the ledger
  tables stay append-only this way.
- **An owner or an accountant writes, posts and reverses a journal alone** (founder's decision,
  2026-11-13). There is no approval step. An auditor reads.
- **A reversal takes no number of its own** and does not appear as a separate row in the list:
  the journal's row says "Reversed". Its date and its lines are on the ledger (Step 16 shows
  them in the general ledger).
- **A reversed journal cannot be copied into a new draft.** The lines have to be typed again.
- **Journals have no attachments** (a scan of the voucher) and no print view yet. Print is Step 16
  onward (`/print/<kind>/<id>`).
- **The entry form offers every account a manual journal may use in one list.** With a long chart
  a search box would be quicker; the same picker will serve every document.
- **Pressing Enter in the form saves the draft; it never posts.** Posting is always a click.
- **A new journal that cannot be posted is kept as a draft**, and the reason is shown on the
  draft's own page.
- **The list shows the newest 200 journals**, with no search, filter or export yet (UI principle
  8); the general ledger and the reports (Step 16) are where journals are searched.
- **Recurring journals** (rent every month, depreciation) are not built.
- **The database does not yet check, when a transaction ends, that every journal has the
  document it claims to be for.** The manual journal's own row is guarded (it becomes posted
  only with the journal the engine posted for it, in the same transaction, with the same date,
  number and lines), but someone able to run their own SQL as the app, as an owner or an
  accountant, could call `app.post_journal` directly and leave a journal with no posted manual
  journal behind it, or take a JV number the series has not handed out, after which posting
  journals in that company fails until it is repaired by hand. The app never does this, and
  that person may post any manual journal anyway, so today it can only harm their own company's
  books. It matters more once a role with less trust posts documents. **Before sales invoices
  post (Step 20), add a deferred constraint trigger on `journals` that, by source type, requires
  the matching document row to point back at the journal** (and the same for reversals). The
  engine's tests post unbacked `manual_journal` journals and will need a document behind each
  one; `docs/PROMPTS.md` has a note for Step 20.
- **The guards on accounts, manual journals and their lines ask which company the session is in
  for every row**, and refuse a row from any other; only a session signed in as postgres (a
  migration, the removal of a test company) is not held to them. A trigger that runs with the
  table owner's rights must never trust a value read once per statement.

## From Step 15

- **Opening balances are one entry per company** (`opening_entries`, with its lines in
  `opening_balances`): what each account stood at, each unpaid customer invoice and each unpaid
  supplier bill. Posting it writes one journal on the opening date, with trade receivables once
  per customer, trade payables once per supplier, and one line to Opening balance equity for
  whatever the rest differ by. It was designed and checked by Claude, not by an accountant.
- **Stock is not part of it.** A line on stock, goods in transit or goods received not invoiced
  is refused: stock is brought in item by item when inventory is built (Step 29 onward), and that
  opening must post against Opening balance equity too, so the account ends at nil. Until then
  the value of the stock sits in Opening balance equity, and the screen says so.
- **Advances and cheques in hand cannot be opened yet** (advances to suppliers, advances from
  customers, post-dated cheques held). They need their own records; the steps that build those
  (Steps 26, 31 and 32) should add their opening lines here.
- **Only what a customer owes is entered, not what the company owes a customer** (a credit
  balance), and the same for suppliers. Enter those as advances once advances can be opened.
- **An unpaid invoice is one amount: what is still unpaid.** Its tax, its lines and its
  salesperson are not brought in. Commission on receipts against opening invoices (Step 39) has
  no salesperson to go to unless that step asks for one.
- **Receipts and payments will be allocated against these opening invoices and bills** (Steps 31
  and 26). Each line has its own id, number, date and due date for that. The ageing shown on the
  opening screen takes nothing off yet for money received since; the real ageing report (Step
  31) replaces it.
- **Age is counted from the invoice's own date**, in bands of 0 to 30, 31 to 60, 61 to 90 and
  over 90 days. The due date is kept for the collections screens, which may age by it instead.
- **The opening date must be in an open fiscal period**, and every invoice and bill must be
  dated before it. A company that starts mid-year brings its income and expense balances for
  the year so far in the trial balance.
- **Posted opening balances are corrected by reversing them**, which posts a second journal and
  starts a new draft holding the same lines. Both journals stay in the books. The reversal is
  always dated on the opening date itself: dated any later, every day in between would show the
  opening balances twice once the corrected ones were posted. So the opening month must be
  unlocked to correct them. Once receipts are allocated against opening invoices (Step 31),
  reversing must be refused or must carry the allocations across.
- **Nothing is posted before the opening date once opening balances are posted**, and opening
  balances cannot be posted after journals already in the books: what happened before that day
  is inside the opening figures and would be counted twice. The engine refuses the first
  (`app.require_open_period`) and the opening entry's own guard the second. A company that never
  posts opening balances (a brand-new business) has no such limit.
- **The opening journal belongs to the whole company**, so only someone who works in every
  branch can enter or read opening balances. Balances by branch are not kept.
- **Balances are in the base currency only.** An unpaid invoice in another currency is entered
  at its rupee value; its foreign amount is not kept (Step 22 and Step 26 decide if they need it).
- **A customer or supplier is named by its code or its exact name**, in the form and in the
  files; where one's code is another's name, the code wins. A picker that searches would remove
  the question, as on prices.
- **A journal holds at most 1,000 lines**, so an opening with more than about 900 customers and
  suppliers together cannot be posted in one entry yet (see "From Step 13").
- **Imports add lines; they never replace.** A file that names an account or an invoice already
  on the draft is refused with the row listed. Files are comma-separated UTF-8, at most 2,000
  rows; amounts without commas. Dates are read year first (2026-06-30) or day first
  (30-06-2026, 30/06/2026), never month first; a file whose dates could be either, with no day
  above 12 to tell, is refused rather than guessed at.
- **A trial balance is matched by this chart's own account codes.** A row whose name is not the
  name of the account its code belongs to stops the import: a file exported from Fast Accounts
  carries Fast Accounts' codes, and the same number can mean a different account here. The
  migration (Step 49) needs a mapping from the old codes to these.
- **The migration of the pilot's books from Fast Accounts (Step 49)** should produce these three
  files from its export.

## From Step 16

- **The four ledger reports only add up posted journal lines**: trial balance, general ledger,
  balance sheet, profit and loss, under Reports, for an owner, an accountant or an auditor. Each
  has a period, a branch, a printed page on the letterhead (`/print/reports/<name>`) and a
  download as Excel or CSV (`/reports/export`). One table (`ReportTable` in
  `src/modules/reports/rules.ts`) feeds all four ways of showing a report.
- **There is no year-end closing entry.** The balance sheet therefore shows, under equity, the
  profit of earlier fiscal years that nothing has moved into retained earnings and the profit
  of the current fiscal year so far. Year-end close ("Period close" on the accountant's menu)
  should post that entry, after which the first of those lines disappears by itself.
- **"Retained earnings" in the acceptance line means the retained earnings account plus every
  income and expense balance to date.** A period's profit is the change in it less whatever was
  posted straight to the retained earnings account (earlier profit brought from old books, a
  dividend). `retainedEarningsStatement` gives the four figures; no screen shows them yet. A
  statement of changes in equity would.
- **Gross profit is a note under the profit and loss**, counting only the Sales account and the
  Cost of goods sold account. Sales returns, discounts and stock adjustments kept in other
  accounts are not part of it. Once the sales documents decide where returns and discounts go
  (Steps 19 and 20), turn the note into a proper section.
- **A branch's reports hold that branch's journals only**, not the company-wide ones (opening
  balances are company-wide). A member limited to some branches sees those branches' books
  whatever they ask for.
- **The general ledger is one account at a time**, 500 entries to a screen page and 20,000 to a
  file or a printed page, with no filter by customer or supplier yet. Customer and supplier
  statements (Step 33) are that filter with their own layout.
- **Every report reads the company's whole ledger up to its end date**, except profit and loss,
  which reads its own period. On a few hundred thousand lines that is under half a second; a
  company with millions of lines will want balances kept per account per month.
- **Amounts in a file keep every decimal the books hold** (two to four). In an Excel file an
  amount is a number; one of a hundred billion or more is written as text, so no digit is lost.
- **The printed page is plain HTML with a Print button.** A real PDF file arrives with Step 23.
- **No cash flow statement, no comparison with last year, no budget.** No saved filters or column
  chooser (UI principle 8).
- **The Reports menu entry for a sales manager is still greyed.** Sales reports come with sales.

## From Step 17

- **`taxLine` in `src/modules/tax/rules.ts` is the tax engine**: one line of a sale in, the
  value, the rate, the sales tax, the further tax and the total out. It reads nothing. The
  caller (the sales documents, Steps 18 to 20) hands it the seller's two answers from
  `getCompanySetup` (registered; prices include tax), the customer's registration and
  active-taxpayer status, the item's category, retail price and sale type, the dated rate rows
  and the company's standard-rate category. `docs/examples/step-17.md` has worked cases,
  checked by Claude, not by an accountant.
- **Whether prices include tax is one answer per company**, given at setup by a company
  registered for sales tax (founder's decision), kept in `company_setup.prices_include_tax`.
  Like the other setup answers it cannot be changed afterwards yet. Companies set up before
  Step 17 have "tax is added on top".
- **The quantity and the price are in the unit the goods were sold in**, so a line of cartons
  comes to exactly cartons times the carton price. The size of that unit in the item's own
  unit (`unitsPerUnitSold`, from Step 8's conversions) is passed alongside and is used only to
  bring the retail price of a Third Schedule item to the quantity sold.
- **Amounts are rounded to the paisa line by line**, halves up: the line's amount first, then
  each tax. A document's totals are the sums of its lines, never worked again from the totals.
- **A registered buyer whose active-taxpayer status was never checked is charged further tax**,
  and the line says so (`furtherTaxReason: "buyer_not_checked"`). The sales screens should show
  that reason beside the tax and point at the customer. The automatic check against FBR's list
  is Step 45.
- **A sale the law takes out of further tax** (SRO 648(I)/2013, such as a sale to an end
  consumer) is the input `furtherTaxExcluded`. Nothing stores it yet: the sales documents
  decide whether it is a mark on the customer, on the document, or both.
- **Extra tax (section 3(5)) is always nil.** The figure exists on every line so that no
  document lacks it; no category carries a rate for it.
- **The engine works in the document's currency and rounds to two decimals whatever the
  currency.** Foreign-currency sales (Step 22) convert the amounts at posting.
- **The rate is the one in force on the date the engine is given.** In law that is the time of
  supply; the sales invoice (Step 20) decides which of its dates that is.
- **Further tax is its own figure on every line and must be its own figure in the books and in
  the return.** It cannot be set against input tax. The chart has one account for sales tax
  payable; Step 20 decides whether further tax needs its own.
- **The item's retail price is the price before sales tax**, as the Act defines it and as the
  item screen now says: a printed price that includes 18% tax is entered divided by 1.18. If
  the pilot's users find that awkward, add a tick on the item for "the printed price includes
  tax" and let the engine do the division. The item screen also shows the tax category, the
  retail price and the FBR fields to a company that is not registered for sales tax; hide them
  there when the sales screens are built (Step 18), to keep "no tax anywhere".
- **The line says which dated rate it used** (`rateFrom`) and why further tax was added. With
  prices that include tax, a discount is a figure that includes tax too; the line does not give
  the discount before tax, which a printed invoice and FBR's format may want (Steps 20 and 23).
- **A rate row that contradicts its category is refused, not obeyed**: a zero-rated category
  with a rate, or a taxed one without. An exempt category needs no rate row at all.
- **FBR's names for the kinds of sale** (`DEFAULT_SALE_TYPES`) were written from memory of
  FBR's digital invoicing list and must be checked against it in Phase 7.
- **A company that registers for sales tax later** still cannot say so: the setup answers
  cannot be changed. It needs a dated record, so that documents before the date carry no tax.


## From Step 18

- **One table holds every sales document** (`sales_documents`, with `sales_lines`,
  `sales_line_salespeople` and `sales_document_links`). Its `kind` already allows a delivery, an
  invoice and a credit note, but only a quotation and an order can be written; Steps 19 to 21
  open the others. The buyer's details and FBR's fields are on the table from the start.
- **A submitted document is never edited.** A wrong order is cancelled, with a reason, and
  written again. Changing an order after it is submitted (an amendment that keeps the number)
  is not built.
- **The credit limit is checked when a sales order is submitted, and only then.** What counts
  against the limit is what the books say the customer owes (trade receivables less any advance
  from the customer), plus every submitted order that is not cancelled, plus the order itself.
  Until invoices exist an order counts in full for ever; **Step 20 must take the invoiced part
  of an order out** (it is then in the receivable) by replacing `app.customer_credit`. Nothing
  closes an order that will never be delivered except cancelling it.
- **A limit of zero means every order needs the owner; no limit means no check.** A quotation
  is never checked. An invoice or a delivery is not checked again (Steps 19 and 20 decide
  whether they should be).
- **Only an owner changes the credit limit of a customer that already exists**, in the app and
  in the database: whoever could move the limit could lift it, sell, and put it back. Whoever
  adds a customer (an owner, an accountant or a sales manager) still sets its first limit, and a
  blank limit means no check. **The founder should confirm this**: the stricter choice is that
  a customer added by anyone but the owner starts with a limit of zero until the owner sets one.
- **Only an owner approves an order over the limit**, with a reason of at least three
  characters, kept on the order and in the audit log (`sales_order.credit_override`). The order
  waits "on hold" meanwhile and shows in the owner's "Needs attention" list. Nobody is sent a
  message about it; the salesperson has to look. A sales manager cannot approve.
- **An order approved days later goes through with the figures it was written with**, unless a
  price list, a tax rate or the customer's tax status has changed since: it is then refused
  and must be sent back to a draft and saved again. The same check stops any draft being
  submitted with figures that have gone stale.
- **A salesperson sees the documents they wrote and the ones filed under them** (the person
  with the largest share). Someone with a smaller share of a colleague's sale does not see the
  document; the commission statement (Step 39) must read the shares, not this rule.
- **Shares are typed once for the document and stored on every line**, so commissions can be
  worked out line by line (Step 38). Different salespeople on different lines of one document
  have no screen. A member is shown by email: members have no names yet.
- **Nothing ties a customer to a salesperson.** "My customers" still shows every customer, and
  any salesperson can write an order for any customer. Assignments come with commissions
  (Step 37).
- **A draft must be complete enough to work out**: a line with no price anywhere is refused
  when the draft is saved, not just when it is submitted.
- **The database, not the app, takes the number, copies the buyer and writes the audit row**
  when a document is submitted, held, sent back or cancelled, so none of them can be invented
  by someone running their own SQL as the app. The row for a submit names every line sold at a
  price that is not the price lists', or with a discount. Changes to a draft made past the app
  are not logged; a draft is not yet a document.
- **Sales documents are written only in ordinary (read committed) transactions.** A transaction
  that reads an older picture of the database is refused, because the checks would not see a
  line or an order committed after it began. The ledger's own functions (Step 13) do not refuse
  such a transaction yet; they should be looked at the same way.
- **Any member except an auditor can ask the database for the next document number directly**
  (`app.next_document_number`, since Step 10), which would leave a gap in a series. The app
  never does. Closing it means taking that right away from the app's role and numbering only
  inside the functions and triggers that submit a document.
- **Anyone who can write a sales order can hold up the credit check of one customer** for as
  long as their own transaction stays open (the lock that makes two orders take turns).
- **The database checks the arithmetic it can** when a document is submitted: totals are the
  lines' own, each line is its quantity at its price less its discount, shares come to 100,
  the unit is one of the item's. It does not work the tax out again: the tax figures are the
  tax engine's, written by the app.
- **A quotation's last day is only shown.** An order can be made from a quotation after it,
  and more than one order from the same quotation.
- **Documents are in the base currency** with a rate of 1 (Step 22). The mark "no further tax
  on this sale" is on the document, not on the customer.
- **Amounts are not rounded to whole rupees.** A round-off line, with its own account, is not
  built; ask the pilot's users whether they want it.
- **The accountant's menu entry "Sales invoices" opens the sales list** until invoices have
  their own (Step 20). Print, PDF, email and the timeline of a document are Step 23. The role
  home screens are still the same for everyone.
- **The item screen still shows the tax category, the retail price and FBR's fields to a
  company that is not registered for sales tax.** Sales documents themselves show no tax there.
- **A weakness in how every table checks role and branch, found in this step's review and
  dating from Step 2. It needs its own hardening step before launch.** Each table's policy
  reads "which company" and "which role" (and "which branches") as separate questions, each
  asked once per statement, the first time it is needed. A member of company T who also owns a
  company X, and who can run their own SQL as the app's role, can write one statement that
  changes the session's company to X halfway: "which company" was already answered T, and
  "which role" is then answered "owner". Shown in the review: a salesperson read a colleague's
  order, and a warehouse manager read a customer's credit limit and audit rows. It never
  crosses companies (the company question still needs a real membership), and the app itself
  never runs such a statement: it needs someone able to run SQL as the app, which nothing
  offers. Writes to sales documents, their lines and the credit limit are closed in Step 18 by
  guards that ask company and role together for every row. Reads, and writes to older tables
  that rely on the policy alone for the role, are not. The fix is to make each policy ask
  company, role and branches in one go (one function that returns the company only when the
  role fits, and one that checks the row's company and branch against a single answer), then
  rewrite every policy to use them, with a test that tries the switch on each table.
- **Whoever adds a customer by their own SQL, past the app, leaves no audit row for it.** The
  app writes one. A second customer with nearly the same name and no credit limit is a way
  round a limit; it shows in the customer list with who added it.

## From Step 19

- **Stock cannot be brought in through the app yet.** Stock is kept as moves (`stock_moves`,
  with what each warehouse holds beside them in `stock_balances`), and so far the only thing
  that writes a move is a delivery note, which takes goods out. Goods come in with purchases
  (Step 24) and opening stock or adjustments (Step 30). Until one of those exists nothing can
  be delivered on a real company: the tests put stock in directly, signed in as postgres
  (`tests/support/stock.ts`). **The founder should decide whether to pull the opening-stock
  screen forward**, so that sales can be tried end to end before purchasing is built.
- **Only the database's own functions write stock or a delivery's journal**
  (`app.post_delivery`, `app.cancel_delivery`). The app's role cannot insert a stock move, and
  a delivery note marked posted or cancelled by hand is refused when the transaction ends,
  because no stock moved with it. Later documents that move stock (goods received, invoices
  without a delivery note, returns, transfers, adjustments) should be built the same way.
- **Cost is the weighted average of what the warehouse holds, item by item, warehouse by
  warehouse**: the value on hand times the quantity leaving, over the quantity on hand, to the
  paisa; the last of the stock takes the last of the value. It follows the order in which
  documents are posted, not their dates: a delivery note dated last week and posted today
  leaves at today's average.
- **The cost of goods sold is posted when the goods are delivered, not when they are
  invoiced.** A delivery in one month invoiced in the next shows its cost a month before its
  revenue. A list of goods delivered and not yet invoiced is needed at each month end (with the
  stock reports, Step 31), and the invoice (Step 20) should follow the delivery promptly: in
  law the tax invoice is due when the goods are supplied.
- **A delivery note carries no tax and no prices on screen.** Its lines hold the order's price
  and discount, so the value of goods delivered and not invoiced can be reported, but tax is
  worked out on the invoice. The warehouse sees quantities only; what the goods cost shows to
  the owner, an accountant and an auditor. In the database a warehouse manager can still read
  the lines of a submitted order, prices and all; only the screens leave them out.
- **What stock is worth cannot be read by the app at all**: the value column of
  `stock_balances` is closed to the app's role, and the moves, which carry cost, are read only
  by the owner, an accountant and an auditor. The stock valuation (Step 31) needs a database
  function that gives the value to those roles.
- **Cancelling a posted delivery note puts the goods back at exactly what they left at** and
  reverses its journal on a date given. It is for a note posted by mistake. Goods that come
  back from a customer after they were invoiced are a sales return (Step 21).
- **A delivery note delivers from the order's own warehouse**, to the order's customer, each
  line of the order once per note. Several notes can be drafted for one order at once; the
  database lets through only what the order still has to deliver when each is posted. There is
  no delivery address, vehicle or receiver beyond a note field (Step 23 prints the note).
- **An order that will never be delivered in full stays "to be delivered" for ever.** It cannot
  be cancelled while it has posted delivery notes, and nothing yet closes it short. Its whole
  total still counts against the customer's credit limit until invoices exist (Step 20).
- **Goods that cost nothing leave no journal**, only the stock move. Batches and serial numbers
  have their columns on every move and are not used yet.
- **The warehouse has no entry in "Needs attention" yet.** Orders waiting to be delivered are
  listed at the top of the delivery notes page, which is where the warehouse's menu leads.
  There is no screen yet that shows what is in stock (Step 31).
- **"Still to deliver" is the same figure for everyone who can see the order**, whoever wrote
  the delivery notes: it is asked of a database function (`app.order_delivered`), because a
  salesperson does not otherwise see a note the warehouse wrote for their order unless the
  order is filed under them or they wrote it.
- **The list of orders waiting to be delivered asks the database about every line of every
  submitted order** each time it is opened. Fine for a pilot; with years of orders it needs a
  figure kept on the order line, or orders marked complete.
- **Reversing the Step 19 migration by hand leaves the Step 18 guards to be put back by hand
  too**; its file says how.

## From Step 20

- **An invoice is made from one delivery note, or straight from one order.** From a delivery
  note it bills exactly that note, once: not part of it, and not several notes on one invoice.
  Straight from an order it bills and delivers what has not yet left the warehouse, all or part.
  One invoice for a month's deliveries to a customer is not built; ask the pilot's users.
- **The price on an invoice is the order's.** It cannot be changed on the invoice, and the list
  price it shows is the one the order recorded. The tax is worked out afresh for the invoice's
  own date and the buyer as recorded that day, so an invoice can carry a different tax from
  its order when a rate or the buyer's status has changed between them.
- **A posted invoice is never changed or cancelled.** A wrong one is corrected by a credit note
  (Step 21). Until then a mistake on a posted invoice can only be put right in the books by a
  manual journal, which does not touch the invoice or the stock.
- **A delivery note that has been invoiced, and an order with anything delivered or invoiced,
  cannot be cancelled.**
- **Every journal now needs its document.** The database refuses, when a transaction ends, a
  journal with no standing document behind it: a manual journal or the opening balances must
  name it, a delivery note or an invoice must carry its number, and a reversal must belong to
  the document whose journal it reverses. This closes the gap noted under Step 14. Each later
  kind of document adds itself to `app.check_journal_backed`.
- **Only `app.post_sales_invoice` writes an invoice's journal**, with the goods when the invoice
  delivers them. An invoice marked posted by hand has no journal and is refused. The database
  does not work the tax out again: the tax on the lines is the tax engine's, written by the
  app. Someone running their own SQL as the app could save a draft with a wrong tax figure and
  post it; the journal would still balance and agree with the invoice, which shows the figure.
- **Further tax is posted to its own locked account, 2205 Further tax payable**, new in every
  chart (a company that already had an account numbered 2205 gets it as 2205-FT). Extra tax,
  if a category ever carries any, goes with ordinary output tax.
- **An invoice falls due on its date plus the customer's credit days as they stood when it was
  posted**; with none set it is due the same day. Receipts and ageing (Steps 32 and 33) read
  this date.
- **What counts against a credit limit** is now the receivable plus the part of each submitted
  order that has not been invoiced (the order's total less the totals of its invoices, never
  below nil). An invoice is not weighed against the limit again when it is posted: its order
  was. An order submitted under the limit can therefore be invoiced after the customer has
  gone over it by other means.
- **The salespeople of an order are the salespeople of its invoices**, copied line by line when
  the invoice is made, for the commission that accrues on invoices (Step 38). A change of
  salespeople after the order is submitted has no screen.
- **FBR's fields are on every invoice and empty.** Nothing submits an invoice to FBR until the
  FBR module is built (Phase 7); the buyer's details FBR needs are kept on the invoice as they
  stood when it was posted. An invoice to an unregistered buyer does not yet ask for the
  buyer's CNIC, which the law requires above a value.
- **The invoice has no print or PDF yet** (Step 23). Its page shows the tax on each line and,
  to those who read the ledger, the journal it posted.
- **Tax is charged by the invoice's date, not the delivery's.** See question 8 in
  `docs/RATES-REVIEW.md`: an invoice dated in the month after its delivery puts the output tax
  in the later month's books.
- **Pressing "Post invoice" posts only what the page already showed.** If saving the draft
  changes its date, a quantity or its tax, the new figures are shown and the invoice is posted
  on the next press. An order's "Submit" still saves and submits in one go: an order can be
  cancelled, an invoice cannot.
- **An invoice that comes to more than its order still had to bill is weighed against the
  credit limit for the difference** (a tax rate that rose, say), and over the limit only an
  owner posts it. No reason is asked for, unlike an order.
- **Goods already delivered are billed even if the customer or the item has been archived
  since**, and the invoice keeps the order's salespeople even if one has left the sales team.
  A new sale to an archived customer, or of an archived item, is still refused.
- **Nothing closes an order that is partly delivered or invoiced and will go no further.** Its
  remainder stays in the warehouse's list and against the customer's credit limit. A "close
  this order short" action is needed.
- **The warehouse is shown the cancel form on a delivery note that has been invoiced**, because
  it does not see invoices; the cancel is then refused with a plain message.
- **For FBR (Phase 7):** the `fbr_*` fields of a posted invoice can only be written by a
  database function of their own, since a posted document is otherwise closed. An invoice that
  FBR rejects after posting cannot be undone, only credited: validate with FBR before posting.
- **Credit notes (Step 21) must come out of what an order has invoiced and of what a customer
  owes**, and the rule that only an invoice has a due date will need widening if they have one.
