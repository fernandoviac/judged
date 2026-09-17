# judged

`judged` is a terminal interface for TypeSafe System One. It presents the API as
a focused sequence: context, question, answer type, type-specific fields, and
answer. It adds no decision framework and does not infer or rewrite the request.

Run it without arguments:

```sh
judged
```

Text fields submit with Enter. Shift+Enter or Option+Enter inserts a newline;
multiline paste is preserved.

```sh
judged  jev-latest
──────────────────────────────────────────────────────────

context
For a large party of friend

question
Which is better?

──────────────────────────────────────────────────────────

answer

pizza  99%
sushi  1%

confidence 0.99  ·  jev-1.13.0  ·  293 in  ·  34 out  ·  1.1s

  1  another  same context
  2  new context
  3  quit
next [1] 3
```

The interface covers all three System One question types:

- **yes / no** (`noul`): optional meanings for yes and no
- **choice**: 2–255 named options with optional descriptions
- **score**: 2–10 ordered, named levels

After an answer, ask another independent question against the same context,
replace the context, or quit. Answers include the model, confidence when the API
provides it, token usage, and elapsed time.

## Install

The published command runs on Node.js 22.18 or newer, Bun, and Deno.

Run it without installing:

```sh
npx @fernandoviac/judged
```

The equivalent Bun and Deno commands are:

```sh
bunx @fernandoviac/judged
deno run --allow-env --allow-read --allow-write --allow-net=api.typesafe.ai npm:@fernandoviac/judged
```

Or install it globally with npm:

```sh
npm install --global @fernandoviac/judged
judged
```

## API key

On the first interactive run, `judged` asks for the TypeSafe API key with input
hidden and stores it in `~/.config/judged/token`. The directory and token file
are restricted to the current user.

For automation, provide `TYPESAFE_API_KEY` or `JEV_API_TOKEN` in the environment.
Environment variables take precedence over the stored token.

The token is sent only as the authorization header to `api.typesafe.ai` and is
never displayed or included in request diagnostics. Do not pass it as a command
argument.
