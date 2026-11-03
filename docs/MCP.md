# Driving F-list Workbench from a model

F-list Workbench runs a local **Model Context Protocol** server. Point
an MCP-capable client at it and the model can do what the app's own
window can: read and rewrite character profiles, set fields and kinks,
browse your F-Chat Logs, label which messages are in-character, and
search the Index.

Two things to hold onto before anything else:

1. **Nothing here uploads to F-list.** Every tool changes local files,
   and every tool that changes something says so in its result
   (`not_published`). When a profile is ready you review it in the app
   window and Upload it yourself in the browser, with the userscript or
   the paired extension. A model that tells you a change is live on
   F-list is wrong.
2. **Live is read-only.** It is the character's profile as it was last
   pulled from F-list. Editing happens in the character's *Workbench*,
   its one local editable copy, which the first edit makes from Live.
   Editing tools always work on the Workbench; read tools read it too
   unless given `source="live"`.

## Connecting

The endpoint is `http://127.0.0.1:27384/mcp`. The app has to be
running; the server lives in its sidecar process. **Settings → MCP**
shows the URL and a copy button for each of the configs below.

### LM Studio

Needs 0.3.17 or newer, and a model that supports tool calling — a
13B-and-up instruct model is the realistic floor. Put this in
`%USERPROFILE%\.lmstudio\mcp.json`:

```json
{
  "mcpServers": {
    "flist-workbench": { "url": "http://127.0.0.1:27384/mcp" }
  }
}
```

### Claude Code

```
claude mcp add --transport http flist-workbench http://127.0.0.1:27384/mcp
```

### Claude Desktop

Desktop only speaks stdio to local servers, so it goes through the
`mcp-remote` bridge — which needs Node installed. In
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "flist-workbench": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:27384/mcp"]
    }
  }
}
```

### Ollama

Ollama is not an MCP client on its own. Use a front-end that is — LM
Studio, Goose, Open WebUI, Jan, Cherry Studio — and point it at your
Ollama model.

### Smaller endpoints

A small local model handed every tool tends to pick badly. Three
narrower endpoints serve the same implementations:

| URL | What it carries |
|---|---|
| `.../mcp` | everything |
| `.../mcp/character` | profile editing, Backups, Pull |
| `.../mcp/logs` | Logs, Labels, search |
| `.../mcp/classify` | the IC/OOC labelling loop only |

[Tools by endpoint](#tools-by-endpoint) lists what each one carries
and how many. Settings → MCP shows the same counts.

Tool schemas are not free. Every tool an endpoint carries is
described in the model's context before it does any work, and `/mcp`
costs several times what a narrow endpoint does. A client with a 12k
window cannot fit one batch of messages to label beside `/mcp/logs`'s
tools. Point a long labelling run at `/mcp/classify`, the smallest
surface.

## Security

Loopback only. The endpoint refuses a request whose `Host` or `Origin`
header points anywhere else, which is what stops a web page you have
open from driving the app.

There is no token by default. That is deliberate: anything already
running as you on this machine can reach the app's REST API without
one, so requiring a token would cost every client a config step and
buy nothing against that. Settings → MCP can switch one on for the
cases where it does help — a shared machine, or a sandboxed tool you
want to keep out. The snippets there then include it.

**No credentials pass through MCP.** There is no sign-in tool; you
sign in to F-list in the app window, and tools that need a session
say so. Nothing a tool reads or sets holds a password or a key — a
secret in a tool call ends up in the client's conversation record.

### Log text

Tools that return Log text — reading, searching and labelling messages
— are off until you turn on **Let MCP clients read Log text** in
Settings → MCP. Those Logs hold your partners' lines as well as yours.
When the client runs a cloud model (Claude, ChatGPT and the like), its
provider receives everything a tool returns. With a local model in LM
Studio or Ollama the text stays on this computer, and turning the
switch on is one click.

While it is off, those tools are missing from every endpoint's list,
and a client that calls one anyway gets `log_text_off`. The tables
below mark them *Log text, opt-in*. The IC/OOC labelling loop needs the
switch on: without it `/mcp/classify` has nothing to fetch messages
with, and its guidelines tell the model to ask you. No tool can turn
the switch on; only you can, in the window.

## What it can do

The full list is under [Tools by endpoint](#tools-by-endpoint). The
ones worth knowing about:

**Finding your way around** — `get_app_status` first, then
`list_characters`.

**Reading a profile** — `get_workbench` (the Workbench by section,
or Live with `source="live"`), `get_description` (pages through a long
one), `list_profile_fields`, `list_kinks`, `list_images`. Each
reads Live with `source="live"` too; Live has no read tool of its own.

**Reading somebody else's profile** — `search_foreign_characters`
finds a name in the user's bookmarks, friends list or chat logs;
`get_foreign_profile` and `get_foreign_kinks` then read it. Strictly
read-only, and there is no tool that copies one of these into the
user's own characters — if asked to, say the app does not do that.
Results cache for 24 hours, and fetching spends a quarter-share of
the hourly F-list budget so a model browsing profiles cannot leave
the user unable to pull their own. When F-list says a profile is gone
or not visible, its cached copy is deleted on the spot.

**Looking at the result** — `render_profile_image` returns the profile
as a picture, rendered by the app's own preview: same BBCode renderer,
same stylesheet, same F-list theme mimics. BBCode is not a format
anyone parses accurately in their head — an unclosed `[collapse]`
swallows the rest of the page, a colour that reads well on Dark can
vanish on Light, an `[img]` id that no longer resolves leaves a hole —
and none of that shows up when you re-read the source you just wrote.
Worth a look after any substantial edit, and worth trying a second
`theme` when the description sets colours. The app window has to
be open: it is the thing that draws. A picture-heavy profile comes
back as JPEG rather than PNG, because the image travels to the model
as base64 and an oversized tool result is refused outright.

**Editing** — the Workbench is created from Live on the first edit.
`edit_description` (an exact string replacement, far safer than
`set_description` on a 30 KB profile), `set_profile_field`,
`set_kinks`, `add_custom_kink`, `reorder_images`. `diff_workbench`
says what an Upload would change. `set_description` and
`edit_description` ask for `confirm=true` when the description would
end up less than half as long as it was, so a model cannot blank one
by accident, with either.

**Images from elsewhere** — `import_images` copies files from folders
you cleared under Settings → Security into a character's pool, and can
swap each one into the place of an existing gallery image
(`replace_image_id`) in the same call. Nothing under the app's own
data folder is imported, even when a cleared folder holds it, so cached
Foreign profile images never reach the pool. Files over F-list's limits come
with a warning; `convert_to_jpeg` re-encodes them where that helps.
`trash_images` deletes into the character's Trash, taking an image off
the gallery first; only you empty the Trash, in the window.

**Logs** — `list_partners`, `read_log_messages`, `search_logs` (one
partner, or all of them when `partner` is left out), `find_contacts`
("have I ever talked to this person, on any of my characters?"), and
`search_logs_semantic`, which finds passages that are *about*
something rather than containing a word. The ones that return
messages need the [Log text](#log-text) switch on.

The two searches fail in opposite directions, and knowing which to
reach for saves a lot of guessing.

`search_logs_semantic` needs the words to mean something to the
embedding model. Invented setting terms often do not: a query for
"Storkakyten" found the right passage only once the spelling matched
the logs exactly, and a near-miss found nothing useful. For a name,
place or coined term you half-remember, `search_logs` on a stem —
`kakyt` — is the better tool. It is a plain substring match, so it
finds every spelling variant a long roleplay accumulates, and it
answers "where is this mentioned at all" rather than "what is the
single most relevant passage".

The other trap is the referent. Chunks carry the *speaker* name on
every line, so asking about a character normally works. But when one
account voices several characters — a GM running the whole crew, or a
player with two figures in one scene — the line says the account name
and the prose says "she". A chunk that only says "she" cannot be found
by a question that names the character, and neighbour expansion does
not rescue it: neighbours expand around chunks that were already
retrieved, and this one never scored. Ask about the *thing* instead —
"machete", "ammunition press" — or use `search_logs`.

**Labels** — see below.

**Operations** — `pull_character`, `create_backup`,
`backup_all_characters`, `ingest_logs`, `export_upload_zip`.
A Pull, Back up all and an ingest are jobs: they wait and report
progress by default, and with `wait=false` return a `job_id` at once,
to poll with `get_job` and stop with `cancel_job` (the same two calls
for every kind, on every endpoint that carries a job). A job runs on
when the call that started it ends.

**Raw payload** — `get_workbench_payload` and `put_workbench_payload`
read and replace the Workbench whole, bypassing the checks the
targeted tools apply. They are on `/mcp` only; the put keeps a Backup
of the Workbench first and needs `confirm=true`.

### How results read

Lists and searches come a page at a time, with a capped `limit`: ask
for more and you get the cap. Every page carries the same `page`:
`offset`, `limit`, `returned`, `total` (null for the semantic search,
which cannot count past the page) and `next_offset`. When
`next_offset` is not null, passing it as `offset` fetches the next
page. `search_logs` without a partner pages the partners, each with up
to `hits_per_partner` hits.

Every tool that deletes or replaces something the user would miss is
marked destructive and refuses to run without `confirm=true`; the
refusal says what would be lost, so the model can ask first.

## The IC/OOC labelling loop

Only messages with an IC/OOC Label are indexed for search. An
Unlabeled message could be roleplay prose or two players chatting
about their weekend, and indexing the latter poisons results — so
ingest skips them.

Three rules decide the easy cases without a model: an empty message, a
message shorter than the threshold (200 characters by default), and one
starting with `((` are all OOC. Everything else is Unlabeled until
something judges it. The app used to run a classifier for that; now
the model you connect does it. It needs the [Log text](#log-text)
switch on:

```
get_label_stats(character, partner)          how much is left
get_labelling_guidelines("de")               the rulebook, once
get_unlabeled_messages(character, partner)   a batch, with context
set_message_labels(character, partner, [...]) the Labels
                                              repeat while remaining > 0
```

A Label the user set by hand in the app is never replaced by a model.
`set_message_labels` leaves it as it is, writes the rest of the call
and lists the hashes it left alone under `skipped`, each with the
reason. Only the user changes or clears such a Label, in the window.

Some conversations do not need judging at all. A user who knows a
chat is in-character from the first line to the last can say so once —
`label_all_unlabeled(character, partner, "IC", confirm=true)`, or
right-click the conversation header in the app — and every unlabeled
message in it gets that Label in one write. It only ever adds:
messages that already carry a Label keep it, and the rules keep
deciding the short lines and `((` asides. The app can undo exactly
that write. A model must not reach for it on its own — only when the
user has said it about that conversation.

Each batch reports how many are left and roughly how many more calls
that means. Worth telling the user before starting: on a long log this
is dozens of rounds — a real run labelled about 15 messages a minute, so
1500 messages took under two hours. With a local model that is time;
with a hosted model it is tokens.

The guidelines come in German (the default), English and a
language-agnostic minimal version. They are the same prompts the
in-app classifier used, so Labels stay comparable with anything
labelled before.

Every batch also carries the decision rule in short form, and every
write reports how many messages are still Unlabeled. That is not
redundancy. A long loop fills the client's context, the client starts
dropping turns, and the first turn to go is the system prompt — holding
the rulebook and the loop protocol. "Re-fetch the guidelines if you
lose them" does not help, because that instruction is in the block that
gets dropped. So each batch is a complete work order: it says how to
judge, where you are, and what to do next, and a model can run the
whole loop with no memory of how it started.

### Running it without running out of context

Tool schemas are charged to the context before any work happens. There
is therefore a floor under every single call:

    tool schemas + one batch of messages

and no client setting can go below it. This is worth spelling out
because it is the failure people hit first, and because it looks like
something a context-overflow policy should solve. It isn't: those
policies manage the *history*. When one request on its own exceeds the
window, discarding history changes nothing.

One batch of 10 messages with their context runs to about 9000 tokens
by itself, measured on a real run. What is left of a small window has
to hold the schemas, and of the four endpoints only `/mcp/classify`'s
fit: `/mcp/logs` already needed about 15000 tokens with a batch, and
the full `/mcp` did not fit in 24k at all.

So: point a labelling run at **`/mcp/classify`**. It carries only the
tools the loop calls, which is the one change that lowers the floor
rather than shuffling what sits above it.

If a batch is still too large, shrink it rather than the context:
`limit=5` roughly halves the payload, and `context_after=0` takes
another slice off. Keep `context_before=1` if you can — the preceding
message is what settles the awkward cases, like a short greeting
between two in-character posts.

In LM Studio, set the context-overflow policy to **Truncate Middle**.
Of the three (`stopAtLimit`, `rollingWindow`, `truncateMiddle`) it is
the only one that fits this shape of work: it keeps the top, where the
rulebook is, and the bottom, where the current batch is, and discards
the middle — which is old batches, and those are exactly what the
self-contained design makes disposable. It also leaves the prompt
prefix intact, so prefix caching keeps working; a rolling window moves
the start of the prompt and costs a full reprocess every round. A real
run got through 1500 messages this way with no drop in speed or
quality. `stopAtLimit` is the honest setting while you are still
calibrating, because it tells you rather than quietly dropping
something.

## Sharing the app with the window

You and a model can edit the same Workbench at the same time. When
that happens the window shows a banner and asks which version to keep
— it will not silently overwrite either side. Changes a model makes
show up in the window without a reload.

The activity log (Help → F-list Activity Log) records every change a
tool made, prefixed `mcp:`.

## When something goes wrong

Tool errors carry a stable code as their first word, then the message
and, where there is more to say, a JSON object of details (the etag on
disk, the field that was wrong). Code and details are the ones the app
window gets for the same situation:

| Code | Means |
|---|---|
| `character_not_found` | no local archive for that name — the error lists the ones that exist |
| `no_workbench` | the character was never pulled, so there is no Live to make a Workbench from |
| `no_live` | the character was never pulled, so there is no Live to read, back up or export |
| `not_signed_in` | needs an F-list session — sign in from the app window |
| `field_not_found` | F-list has no such field; `list_profile_fields` shows what exists (an unknown kink in `set_kinks` is a `validation_failed` naming it under `problems`) |
| `validation_failed` | a value F-list wouldn't accept, or a `source` other than `workbench` (the default) or `live` — the error carries the allowed ones |
| `bbcode_rejected` | the description has BBCode F-list would refuse; the error names the tags |
| `image_not_found` | no image with that id where the tool looked (`list_trash` shows what the Trash holds) |
| `etag_mismatch` | the Workbench changed since it was read (`put_workbench_payload` with an old `if_match`); details carry the `current_etag` |
| `confirm_required` | a destructive tool, or `set_description` or `edit_description` cutting the description below half its length; ask the user, then pass `confirm=true` |
| `workbench_not_kept` | replacing the Workbench (a Restore, or `put_workbench_payload`) needs a Backup of it first, and that Backup could not be written, so nothing was replaced |
| `backup_too_old` | the Backup comes from before the app stored a loadable profile in it; it can only be downloaded |
| `window_not_running` | `render_profile_image` needs the app window open |
| `log_character_not_found` | no F-Chat Logs for that character — the error lists the ones that exist |
| `partner_not_found` | no conversation with that partner; `list_partners` has the names as stored |
| `nothing_written` | `set_message_labels` could store none of the Labels (hashes not from this conversation); fetch a fresh batch |
| `log_text_off` | a tool that returns Log text, while Settings → MCP keeps those off; the user turns them on |
| `no_index` | nothing ingested yet |
| `index_busy` | an ingest (or a wipe) is changing the Index; details carry its `job_id` to poll with `get_job` or stop with `cancel_job` |
| `character_busy` | a Pull of that character, or Back up all, is running (one at a time); details carry its `job_id` to poll with `get_job` or stop with `cancel_job` |
| `index_unreadable` | the Index is there but could not be read; not the same as empty |
| `keyword_backfill_failed` | a hybrid search found the keyword half of the Index empty and could not fill it from the vector half; search with `hybrid=false` meanwhile |
| `job_not_found` | no job with that id: finished jobs are forgotten after a few minutes, and none survive a restart |
| `embedding_failed` | the embedding model would not load (it runs in-process and downloads itself on first use); `get_rag_status` with `check_embedding=true` checks it |
| `embedding_model_changed` | an ingest found an Index built with another embedding model; `wipe_search_index`, then ingest again |
| `log_dir_unavailable` | the F-Chat data directory in Settings is wrong |
| `not_found` | F-list will not show that Foreign profile: no such character, or it is deleted, private or blocks the account (F-list's answer does not say which); any cached copy has been deleted |
| `rate_limited` | MCP's share of the hourly F-list budget is spent; details carry the stale cached copy under `cached` when there is one |
| `flist_unreachable` | F-list could not be reached (offline, timed out) and nothing is cached; with a cached copy the tool answers with it marked `stale` instead |
| `flist_server_error` | F-list's server failed (HTTP 5xx) and nothing is cached; says nothing about whether the character exists |

## Tools by endpoint

Every tool each endpoint carries, as a client lists it. The second
count is what the endpoint lists while the [Log text](#log-text)
switch is off, which is the default: tools marked *Log text, opt-in*
appear only once you turn it on. A test compares these tables with the
server, so they cannot drift from it.

### `/mcp`: 66 tools (62 while Log text is off)

| Tool | What it does |
|---|---|
| `get_app_status` | The app's state: version, data folder, F-list session, characters, Logs and Index. Call it first. |
| `list_characters` | Every character the app has locally. |
| `get_activity_log` | Recent activity, newest first, every change a tool made included. |
| `get_settings` | The app's settings: Log folder, IC/OOC rule threshold, embedding model, retrieval tuning, image folders. |
| `update_settings` | Change settings; switching a model deletes the old one's weights. Image folders and the Log-text switch stay the user's, in the window. |
| `get_extension_pairing_status` | Whether the browser extension is paired, which an Upload needs. |
| `get_workbench` | The Workbench by section; `source="live"` reads Live, the profile as last pulled. |
| `get_description` | The description in BBCode, a page at a time for a long one. |
| `list_profile_fields` | Profile fields with their type, allowed options and current value. |
| `list_kinks` | Kink choices by name, custom kinks included. |
| `list_images` | The gallery, plus images in the pool that are not on the profile. |
| `diff_workbench` | What an Upload would change: the Workbench against Live. |
| `render_profile_image` | The profile drawn as a picture by the app's own preview; the window has to be open. |
| `get_mapping_list` | F-list's catalogue of what a profile can hold: fields, options, kinks. |
| `get_bbcode_reference` | F-list's BBCode dialect, the markup a description uses. |
| `set_description` | Replace the whole description. Needs `confirm=true` when the new text is under half the old length. |
| `edit_description` | Replace an exact piece of text in the description. Needs `confirm=true` when it would leave under half the description. |
| `set_custom_title` | Set the line under the character's name. |
| `set_profile_field` | Set one profile field: species, height, orientation and so on. |
| `clear_profile_field` | Remove a profile field so it does not show. |
| `set_profile_settings` | The profile's display and visibility switches. |
| `set_kinks` | Set the choice of one or many kinks. |
| `add_custom_kink` | Add a kink in the user's own words. |
| `update_custom_kink` | Change a custom kink's name, description or choice. |
| `delete_custom_kink` | Remove a custom kink. Needs `confirm=true`. |
| `put_back_custom_kink` | Put back a custom kink delete_custom_kink removed. |
| `reorder_custom_kinks` | Set the order of the custom kinks. |
| `set_image_description` | Set the caption under a gallery image. |
| `reorder_images` | Set the order of the gallery. |
| `add_image` | Put an image from the pool onto the gallery. |
| `remove_image` | Take an image off the gallery; the file stays in the pool. |
| `import_images` | Copy image files from folders the user cleared into the pool, optionally onto the gallery. |
| `trash_images` | Delete images: off the gallery, out of the pool, into the Trash. |
| `list_trash` | What the character's Trash holds: images, Backups, cleared Labels. |
| `put_back_images` | Put images from the Trash back into the pool. |
| `create_backup` | Keep a Backup of the Workbench. |
| `list_backups` | The character's Backups, newest first. |
| `load_backup_into_workbench` | Restore: load a Backup into the Workbench, keeping a Backup of what it held. Needs `confirm=true`. |
| `backup_all_characters` | Pull every character on the account and keep each Live as a Backup. A job. |
| `export_upload_zip` | Save the Workbench as the ZIP the user uploads to F-list. |
| `get_workbench_payload` | The Workbench's raw payload and its `etag`. |
| `put_workbench_payload` | Replace the whole Workbench payload, keeping a Backup of what it held. Needs `confirm=true`. |
| `pull_character` | Pull: fetch a character's profile and images from F-list into its Live. A job. |
| `search_foreign_characters` | Names to look up: from bookmarks, friends or Logs, or a name as typed. |
| `get_foreign_profile` | Somebody else's public profile, read-only. |
| `get_foreign_kinks` | The kink choices on somebody else's profile. |
| `list_log_characters` | Which of the user's characters have Logs on this machine. |
| `list_partners` | Everyone a character has Logs with. |
| `read_log_messages` | *Log text, opt-in.* Messages from one conversation, oldest first, 200 a page. |
| `search_logs` | *Log text, opt-in.* Find a word or name in a character's Logs, with one partner or all. |
| `find_contacts` | Whether the user ever talked to someone, on any character. |
| `list_aliases` | Partner names linked as the same person. |
| `add_alias` | Link two partner names as the same person. |
| `remove_alias` | Unlink a partner name. Needs `confirm=true`. |
| `get_label_stats` | How much of a conversation, or of all of them, has an IC/OOC Label. |
| `get_labelling_guidelines` | The rulebook for labelling a message IC or OOC. |
| `get_unlabeled_messages` | *Log text, opt-in.* A batch of Unlabeled messages, each with its neighbours. |
| `set_message_labels` | Store IC/OOC Labels for messages. |
| `label_all_unlabeled` | Give every Unlabeled message in one conversation the same Label. Needs `confirm=true`. |
| `clear_labels` | Clear stored Labels into the Trash. Needs `confirm=true`. |
| `ingest_logs` | Index labelled messages so search_logs_semantic finds them. A job. |
| `search_logs_semantic` | *Log text, opt-in.* Find passages that are about something, not ones holding a word. |
| `get_rag_status` | What the Index holds, and whether the embedding model loads. |
| `wipe_search_index` | Delete the Index; Logs and Labels stay. Needs `confirm=true`. |
| `get_job` | Progress and result of a job started with `wait=false`. |
| `cancel_job` | Stop a running job; what it already wrote stays. |

### `/mcp/character`: 47 tools

| Tool | What it does |
|---|---|
| `get_app_status` | The app's state: version, data folder, F-list session, characters, Logs and Index. Call it first. |
| `list_characters` | Every character the app has locally. |
| `get_activity_log` | Recent activity, newest first, every change a tool made included. |
| `get_settings` | The app's settings: Log folder, IC/OOC rule threshold, embedding model, retrieval tuning, image folders. |
| `update_settings` | Change settings; switching a model deletes the old one's weights. Image folders and the Log-text switch stay the user's, in the window. |
| `get_extension_pairing_status` | Whether the browser extension is paired, which an Upload needs. |
| `get_workbench` | The Workbench by section; `source="live"` reads Live, the profile as last pulled. |
| `get_description` | The description in BBCode, a page at a time for a long one. |
| `list_profile_fields` | Profile fields with their type, allowed options and current value. |
| `list_kinks` | Kink choices by name, custom kinks included. |
| `list_images` | The gallery, plus images in the pool that are not on the profile. |
| `diff_workbench` | What an Upload would change: the Workbench against Live. |
| `render_profile_image` | The profile drawn as a picture by the app's own preview; the window has to be open. |
| `get_mapping_list` | F-list's catalogue of what a profile can hold: fields, options, kinks. |
| `get_bbcode_reference` | F-list's BBCode dialect, the markup a description uses. |
| `set_description` | Replace the whole description. Needs `confirm=true` when the new text is under half the old length. |
| `edit_description` | Replace an exact piece of text in the description. Needs `confirm=true` when it would leave under half the description. |
| `set_custom_title` | Set the line under the character's name. |
| `set_profile_field` | Set one profile field: species, height, orientation and so on. |
| `clear_profile_field` | Remove a profile field so it does not show. |
| `set_profile_settings` | The profile's display and visibility switches. |
| `set_kinks` | Set the choice of one or many kinks. |
| `add_custom_kink` | Add a kink in the user's own words. |
| `update_custom_kink` | Change a custom kink's name, description or choice. |
| `delete_custom_kink` | Remove a custom kink. Needs `confirm=true`. |
| `put_back_custom_kink` | Put back a custom kink delete_custom_kink removed. |
| `reorder_custom_kinks` | Set the order of the custom kinks. |
| `set_image_description` | Set the caption under a gallery image. |
| `reorder_images` | Set the order of the gallery. |
| `add_image` | Put an image from the pool onto the gallery. |
| `remove_image` | Take an image off the gallery; the file stays in the pool. |
| `import_images` | Copy image files from folders the user cleared into the pool, optionally onto the gallery. |
| `trash_images` | Delete images: off the gallery, out of the pool, into the Trash. |
| `list_trash` | What the character's Trash holds: images, Backups, cleared Labels. |
| `put_back_images` | Put images from the Trash back into the pool. |
| `create_backup` | Keep a Backup of the Workbench. |
| `list_backups` | The character's Backups, newest first. |
| `load_backup_into_workbench` | Restore: load a Backup into the Workbench, keeping a Backup of what it held. Needs `confirm=true`. |
| `backup_all_characters` | Pull every character on the account and keep each Live as a Backup. A job. |
| `export_upload_zip` | Save the Workbench as the ZIP the user uploads to F-list. |
| `pull_character` | Pull: fetch a character's profile and images from F-list into its Live. A job. |
| `search_foreign_characters` | Names to look up: from bookmarks, friends or Logs, or a name as typed. |
| `get_foreign_profile` | Somebody else's public profile, read-only. |
| `get_foreign_kinks` | The kink choices on somebody else's profile. |
| `get_rag_status` | What the Index holds, and whether the embedding model loads. |
| `get_job` | Progress and result of a job started with `wait=false`. |
| `cancel_job` | Stop a running job; what it already wrote stays. |

### `/mcp/logs`: 28 tools (24 while Log text is off)

| Tool | What it does |
|---|---|
| `get_app_status` | The app's state: version, data folder, F-list session, characters, Logs and Index. Call it first. |
| `list_characters` | Every character the app has locally. |
| `get_activity_log` | Recent activity, newest first, every change a tool made included. |
| `get_settings` | The app's settings: Log folder, IC/OOC rule threshold, embedding model, retrieval tuning, image folders. |
| `update_settings` | Change settings; switching a model deletes the old one's weights. Image folders and the Log-text switch stay the user's, in the window. |
| `get_extension_pairing_status` | Whether the browser extension is paired, which an Upload needs. |
| `get_mapping_list` | F-list's catalogue of what a profile can hold: fields, options, kinks. |
| `get_bbcode_reference` | F-list's BBCode dialect, the markup a description uses. |
| `list_log_characters` | Which of the user's characters have Logs on this machine. |
| `list_partners` | Everyone a character has Logs with. |
| `read_log_messages` | *Log text, opt-in.* Messages from one conversation, oldest first, 200 a page. |
| `search_logs` | *Log text, opt-in.* Find a word or name in a character's Logs, with one partner or all. |
| `find_contacts` | Whether the user ever talked to someone, on any character. |
| `list_aliases` | Partner names linked as the same person. |
| `add_alias` | Link two partner names as the same person. |
| `remove_alias` | Unlink a partner name. Needs `confirm=true`. |
| `get_label_stats` | How much of a conversation, or of all of them, has an IC/OOC Label. |
| `get_labelling_guidelines` | The rulebook for labelling a message IC or OOC. |
| `get_unlabeled_messages` | *Log text, opt-in.* A batch of Unlabeled messages, each with its neighbours. |
| `set_message_labels` | Store IC/OOC Labels for messages. |
| `label_all_unlabeled` | Give every Unlabeled message in one conversation the same Label. Needs `confirm=true`. |
| `clear_labels` | Clear stored Labels into the Trash. Needs `confirm=true`. |
| `ingest_logs` | Index labelled messages so search_logs_semantic finds them. A job. |
| `search_logs_semantic` | *Log text, opt-in.* Find passages that are about something, not ones holding a word. |
| `get_rag_status` | What the Index holds, and whether the embedding model loads. |
| `wipe_search_index` | Delete the Index; Logs and Labels stay. Needs `confirm=true`. |
| `get_job` | Progress and result of a job started with `wait=false`. |
| `cancel_job` | Stop a running job; what it already wrote stays. |

### `/mcp/classify`: 10 tools (9 while Log text is off)

| Tool | What it does |
|---|---|
| `list_log_characters` | Which of the user's characters have Logs on this machine. |
| `list_partners` | Everyone a character has Logs with. |
| `get_label_stats` | How much of a conversation, or of all of them, has an IC/OOC Label. |
| `get_labelling_guidelines` | The rulebook for labelling a message IC or OOC. |
| `get_unlabeled_messages` | *Log text, opt-in.* A batch of Unlabeled messages, each with its neighbours. |
| `set_message_labels` | Store IC/OOC Labels for messages. |
| `label_all_unlabeled` | Give every Unlabeled message in one conversation the same Label. Needs `confirm=true`. |
| `ingest_logs` | Index labelled messages so search_logs_semantic finds them. A job. |
| `get_job` | Progress and result of a job started with `wait=false`. |
| `cancel_job` | Stop a running job; what it already wrote stays. |

## For reference

- Design and rationale (a historical record): `docs/MCP_DESIGN.md`
- What the app is: `docs/OVERVIEW.md`
- LM Studio's MCP docs: https://lmstudio.ai/docs/app/mcp
- Connecting local servers to Claude Desktop:
  https://modelcontextprotocol.io/docs/develop/connect-local-servers
