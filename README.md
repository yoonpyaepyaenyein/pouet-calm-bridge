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

There is no worker and nothing to schedule: the request that wins does the work
before it responds. Threads are independent, so several can run at once.

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

## Not here yet

The fact-checking part of the ticket (web search and article citations) is not
in this version. The app's `feature-ai-summary` package has that code and it
can move here later; the flow above does not change when it does.

## Running it

```bash
yarn install
yarn test          # no network, no Redis, no keys needed
vercel link        # once, to attach this folder to a Vercel project
vercel --prod
```

Set the variables from `.env.example` in the Vercel project settings, and
attach a Redis store to the project so the `KV_*` variables appear.
