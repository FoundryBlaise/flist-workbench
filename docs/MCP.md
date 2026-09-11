# Driving Workbench from a model

Workbench runs a local **Model Context Protocol** server. Point an
MCP-capable client at it and the model can do what the app's own
window can: read and rewrite character profiles, set fields and kinks,
browse your F-Chat logs, decide which messages are in-character, and
search the index.

Two things to hold onto before anything else:

1. **Nothing here uploads to F-list.** Every tool changes local files.
   When a profile is ready you review it in the Workbench window and
   publish it yourself in the browser, with the userscript or the
   paired extension. A model that tells you a change is live on F-list
   is wrong.
2. **`live` is read-only.** It is the record of what is published.
   Editing happens in a *working set* — a named local draft. A
   character can have several; one is active at a time.

## Connecting

The endpoint is `http://127.0.0.1:27384/mcp`. Workbench has to be
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

A small local model handling 70 tools tends to pick badly. Two narrower
endpoints serve the same implementations:

| URL | What it carries |
|---|---|
| `.../mcp` | everything (70 tools) |
| `.../mcp/character` | profile editing (53) |
| `.../mcp/logs` | logs, labels, search (29) |

## Security

Loopback only. The endpoint refuses a request whose `Host` or `Origin`
header points anywhere else, which is what stops a web page you have
open from driving your Workbench.

There is no token by default. That is deliberate: anything already
running as you on this machine can reach the app's REST API without
one, so requiring a token would cost every client a config step and
buy nothing against that. Settings → MCP can switch one on for the
cases where it does help — a shared machine, or a sandboxed tool you
want to keep out. The snippets there then include it.

**No credentials pass through MCP.** There is no sign-in tool; you
sign in to F-list in the Workbench window, and tools that need a
ticket say so. The embedding API key can be read as a yes/no but never
as a value, and cannot be set through a tool — a secret in a tool call
ends up in a transcript.

## What it can do

70 tools. The ones worth knowing about:

**Finding your way around** — `get_workbench_status` first, then
`list_characters`, `list_working_sets`, `explain_set_addressing` if an
addressing error is puzzling.

**Reading a profile** — `get_description` (pages through a long one),
`list_profile_fields`, `list_kinks`, `list_images`, `get_live_profile`.

**Editing** — `create_working_set`, then `edit_description` (an exact
string replacement, far safer than `set_description` on a 30 KB
profile), `set_profile_field`, `set_kink`, `add_custom_kink`,
`reorder_images`. `diff_working_set` says what would change if you
published.

**Logs** — `list_partners`, `read_log_messages`, `search_logs`,
`find_contacts` ("have I ever talked to this person, on any of my
characters?"), and `search_logs_semantic`, which finds passages that
are *about* something rather than containing a word.

**Labels** — see below.

**Operations** — `pull_character`, `create_backup`,
`backup_all_characters`, `ingest_logs`, `export_restore_zip`.

## The classification loop

Only messages with an IC/OOC verdict are indexed for search. An
unjudged message could be roleplay prose or two players chatting about
their weekend, and indexing the latter poisons results — so ingest
skips them.

Three rules decide the easy cases without a model: an empty message, a
message shorter than the threshold (200 characters by default), and one
starting with `((` are all OOC. Everything else is Unlabeled until
something judges it. Workbench used to run a classifier for that; now
the model you connect does it:

```
get_label_stats(character, partner)          how much is left
get_classification_guidelines("de")          the rulebook, once
get_messages_to_classify(character, partner) a batch, with context
set_message_labels(character, partner, [...]) the verdicts
                                              repeat while remaining > 0
```

Each batch reports how many are left and roughly how many more calls
that means. Worth telling the user before starting: on a long log this
is dozens of rounds. With LM Studio that is time; with a hosted model
it is tokens.

The guidelines come in German (the default), English and a
language-agnostic minimal version. They are the same prompts the
in-app classifier used, so verdicts stay comparable with anything
labelled before.

## Sharing the app with the window

You and a model can edit the same working set at the same time. When
that happens the window shows a banner and asks which version to keep
— it will not silently overwrite either side. Changes a model makes
show up in the window without a reload.

The activity log (Help → F-list Activity Log) records every change a
tool made, prefixed `mcp:`.

## When something goes wrong

Tool errors carry a stable code as their first word:

| Code | Means |
|---|---|
| `character_not_found` | no local archive for that name — the error lists the ones that exist |
| `no_active_set` | nothing is active; create one or name one explicitly |
| `live_is_read_only` | tried to edit the published profile |
| `not_signed_in` | needs an F-list session — sign in from the Workbench window |
| `field_not_found`, `kink_not_found` | F-list has no such field or kink; the list tools show what exists |
| `validation_failed` | a value F-list wouldn't accept — the error carries the allowed ones |
| `etag_conflict` | the window saved while the edit was in flight |
| `confirm_required` | a destructive tool; ask the user, then pass `confirm=true` |
| `no_index` | nothing ingested yet |
| `embedding_unreachable` | the embedding endpoint isn't answering |
| `log_dir_unavailable` | the F-Chat data directory in Settings is wrong |

## For reference

- Design and rationale: `docs/MCP_DESIGN.md`
- What the app is: `docs/OVERVIEW.md`
- LM Studio's MCP docs: https://lmstudio.ai/docs/app/mcp
- Connecting local servers to Claude Desktop:
  https://modelcontextprotocol.io/docs/develop/connect-local-servers
