# Calm the conversation bridge

A small server behind the lotus button in the PouetSocial mobile app. When
someone asks for a thread to be calmed, it reads the conversation, has a model
write one short de-escalating message, and publishes it as a bot account so
everyone in the thread sees it.

It exists because the app cannot do this itself: an API key shipped inside an
app binary can be extracted, a bot token even more so, and "someone already
pressed the lotus" has to be true for every reader, not just one phone.

## How one press works

```
app  --POST /api/calm {instance, statusId} + the user's token-->  bridge
                                                                   |
                      who is this? --------> Mastodon verify_credentials
                      what is the thread? -> Mastodon status + context
                      lock the thread ------> Redis  (SET NX)
                      write the reply ------> Mistral
                      publish as the bot ---> Mastodon POST /statuses
                      remember it is done --> Redis
app  <------------------- {state: "done", statusIds, botStatusId}
```

Everyone else sees the result because the app asks `/api/states` for the posts
on screen and gets back which threads are `loading` or `done`.

## One reply at a time, without a queue

A thread is identified by its root status id, so pressing the lotus on the
original post or on any reply reaches the same keys. The lock is its own short
lived key: `SET NX` writes it only if it does not exist, so when two people
press at the same moment exactly one request wins and the other is told the bot
is already answering.

There is no worker and nothing to schedule: the request that wins does the work.
Most runs finish within 50 seconds and answer `done`, so an error still reaches
the person who pressed. A slower run answers `loading` at that point and keeps
going in the background (Vercel's `waitUntil`, up to the function's 120 second
`maxDuration`); the app follows the thread until it turns red, and a run that
fails there frees the lotus itself. Threads are independent, so several can run
at once.

- The replies known when the bot runs get a copy of the state, so every reader
  sees the same lotus on them.
- A calmed thread stays `done` for 30 days, so the lotus stays red.
- A crashed run leaves a lock that expires after 3 minutes, so the lotus cannot
  spin forever.
- A failed run frees the lock at once and puts the lotus back as it was, so a
  thread calmed last week stays red when a later press fails.

## Asking again

The bot may be asked again later: a thread that has carried on since its last
calming message gets a fresh one. What it will not do is answer itself, so a
press is refused with `already_calmed` while the last post below the pressed one
is the bot's own. The app asks first with `{ check: true }`, which reports
`{ canCalm }` without publishing anything or calling the model, so it can show
the right explanation instead of a failed confirmation.

The bot's own account id is read once a day through `verify_credentials` and
cached, so recognising its replies costs nothing per press. The idempotency key
names the round (`calm:<instance>:<pressed post>:<last post below it>`), so a
retry after a timeout cannot publish twice, while a thread that has moved on
gets a new key and so a new reply.

If the model is later replaced by a slower self-hosted one, this is the part
that has to change: a request that runs for minutes needs a background job and
a worker instead.

## Endpoints

Both take `Authorization: Bearer <the user's Mastodon token>`.

| | |
|---|---|
| `POST /api/calm` | `{ instance, statusId }` → `{ state, rootId, statusIds, botStatusId }` |
| `POST /api/calm` | `{ instance, statusId, check: true }` → `{ canCalm, rootId, statusIds }`, publishing nothing |
| `POST /api/states` | `{ instance, statusIds[] }` → `{ states: { id: "loading" \| "done" } }` |

Errors are `{ error: "<code>" }` with codes the app translates:
`unauthorized`, `unknown_instance`, `invalid_request`, `status_not_found`,
`restricted_conversation`, `already_calmed`, `empty_conversation`,
`conversation_too_long`,
`mastodon_unavailable`, `bot_post_failed`, `rate_limit`, `timeout`,
`invalid_response`, `response_too_long`, `configuration`, `server`.

## What it will not do

- Contact a server that is not named in `CALM_INSTANCES`.
- Trust an account id sent by the caller: Mastodon identifies the token.
- Send a private or direct thread to the model.
- Publish text containing a link, an email address or an extra `@mention`, or a
  sentence the model did not finish. Such an answer is refused and the lotus
  becomes pressable again.
- Reply more publicly than the thread it is in.

## Fact-check (optional)

The ticket asks the bot to say what is true on each side, "possibly using our
related news articles and fact-checking resources". `lib/factcheck.js` is that
step. It is off unless `FACTCHECK_MODE` says otherwise:

| Mode | What happens |
|---|---|
| `off` (default) | Nothing runs. |
| `log` | Beside each reply, the model is asked whether the thread holds a checkable claim (a figure, a date, an event). If it does, trusted sites are searched and the result is recorded in Redis for 14 days. The reply does not change. |
| `on` | The search runs first. The reply is written exactly as without it. If a kept result settles the claim, a separate short call writes one sentence starting "Selon <publisher>," (or "According to <publisher>,"), and the bridge checks it: no figure the source does not give, no verdict, no copied passage, about the claim. Only then are the sentence and the source's link added under the reply. Otherwise the reply goes out alone, never with a bare link. |

How it stays safe:

- Only sites on an allowlist are searched (`FACTCHECK_DOMAINS`, or the built-in
  list: Ouest-France, AFP Factuel, Le Monde Les Décodeurs, franceinfo Vrai ou
  faux, Libération CheckNews, Droit à l'Info, Les Surligneurs). Every result is checked against
  the list again, so a lookalike host never passes.
- A result is kept only if it carries every number the claim names and shares
  at least two of its subject words, so a piece on a 5 % deficit never reaches
  the model for a claim about a 40 % rise.
- Each app searches **its own newspaper** plus the shared fact-checkers (Pouet:
  ouest-france.fr, Humanité: humanite.fr), so a Humanité thread never cites a
  competitor. `CALM_<ID>_FACTCHECK_DOMAINS` overrides the list for one app and
  `CALM_<ID>_BOT_NAME` sets the name its bot uses in the prompt.
- Pages are never fetched. Only the search result's title and snippet are kept,
  because several sources forbid reproducing their articles.
- The search engine (Serper) receives a few plain words, never the thread, a
  name, a handle or a link, and search operators are stripped from them.
  Serper's privacy policy names no company address and allows storage outside
  the EEA; whether that is acceptable is the client's call.
- Mistral's free tier allows 2 requests a minute **per model**, so the claim
  check runs on `FACTCHECK_CLAIM_MODEL` (default ministral-8b) and the source
  sentence on `FACTCHECK_LINE_MODEL` (default ministral-3b). The reply model is
  still called once per press, as with fact-check off.
- The whole step has 10 seconds and never throws: without a key, on a timeout
  or on an odd answer the bot replies exactly as it would have.
- Vera (askvera.org) is not used. Its terms forbid automated requests and
  commercial use.

Reviewing what log mode found:

```bash
node --env-file=.env.local scripts/factcheck-log.js      # last 20 results
MISTRAL_API_KEY=... SERPER_API_KEY=... node scripts/try-prompt.js --factcheck
```

## Running it

```bash
yarn install
yarn test          # no network, no Redis, no keys needed
vercel link        # once, to attach this folder to a Vercel project
vercel --prod
```

Set the variables from `.env.example` in the Vercel project settings, and
attach a Redis store to the project so the `KV_*` variables appear.
