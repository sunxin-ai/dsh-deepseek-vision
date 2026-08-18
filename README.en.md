# dsh-design-qa

[![npm](https://img.shields.io/npm/v/dsh-design-qa)](https://www.npmjs.com/package/dsh-design-qa)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[简体中文](README.md) | English

**Let text-only models in DeepSeek Harness read images.**

- **Any text-only model, not just DeepSeek.** The OpenAI-compatible endpoints you wire up
  yourself work too. On the day official multimodal ships, this plugin steps aside on its own —
  you can leave it installed.
- **Looking is a tool, not a pipeline.** Images never enter the main model's context. It sees a
  one-line `[图片 …]` pointer and calls `deepseek_vision` when it decides it needs to. Not looking
  costs nothing; what to ask is the model's call.
- **Ships with an evaluation you can run.** Four fixtures, twenty-three injected defects, four
  pass lines. Swap the vision model and re-run it to find out whether the new one can do the job.

---

## Install in three steps

**Prerequisite:** a DSH **you can already hold a conversation with** — workspace picked, main
model key configured, a test message comes back. npm install or from source, either works.
Node `^22.19 || >=24` (same as DSH). macOS / Linux / Windows; the installer is one Node script.

> If you just downloaded DSH, finish that first. This plugin owns only the vision leg
> (`BAILIAN_API_KEY`); the main model's key is DSH's own business. They are separate — if the main
> model can't talk, pasting an image won't do anything either.

### 1. Get a Bailian API key

Create an API-KEY at the [Aliyun Bailian console](https://bailian.console.aliyun.com/).

**New accounts get 1M input + 1M output tokens per model, valid 90 days**
([official notice](https://help.aliyun.com/zh/model-studio/new-free-quota)). One look costs roughly
2000 input + 400 output tokens, so **the free tier covers a few hundred images** — day-to-day use
is effectively free.

### 2. Install the plugin

```sh
dsh plugin --profile web add dsh-design-qa
```

> You can also install straight from GitHub (that gets you the tip of `main`, which is not
> necessarily what's on npm): `dsh plugin --profile web add github:sunxin-ai/dsh-design-qa`

### 3. Configure and cold-restart

```sh
cd "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-design-qa"
export BAILIAN_API_KEY=<the key from step 1>
node install.mjs --route-only
node install.mjs --restart          # cold start. HMR is off; reloading the browser is not enough
```

Done. **Paste an image into the chat box and just ask "what is this".**

> Images go in by **paste or drag** — DSH's composer has no separate upload button, and the `+` at
> the bottom left is the command menu, not an attachment picker. Don't go looking for it.
> You can also hand the model an **absolute path** or an **http(s) URL** and let it call
> `deepseek_vision` itself.

You don't have to tell the installer where DSH lives — it resolves the core packages out of the
profile's `node_modules`, which works for both npm installs and source checkouts. It never handles
your key either; it only writes the variable name, `apiKeyEnv: BAILIAN_API_KEY`.

<details>
<summary>Step 3 also edits DSH core in three places — open this to see what and how to undo it</summary>

"Paste an image into the chat box" is not something a plugin can do on its own. The refusal lives
in `api-proxy`'s message admission, and `resolveModelInfo` returns whatever the adapter says about
itself with no waterfall, so a plugin cannot change the adapters' hardcoded
`inputModalities: ['text']`. Hence three edits to core:

| Site | Change |
|---|---|
| `dsh-host-apiproxy` | Drop the image-admission refusal for text-only routes (one `if` block) |
| `dsh-llm-deepseek` | Replace image blocks with a `[图片 … attachment=<id>]` text pointer just before serialization, instead of throwing |
| `dsh-llm-pi-ai` | Same — this one covers **every** OpenAI-compatible text-only endpoint you configure |

The first two only make pasting work on DeepSeek routes; the third is what makes "**any** text-only
model can read images" actually true.

Each file's original is saved next to it as `<name>.dsh-design-qa-orig`. One command undoes all of it:

```sh
node install.mjs --revert-patches
```

**Don't want core touched at all?** Add `--no-patches`. Pasting stays refused, but **handing the
model a path, a URL, or an attachment id still works** — you just paste a path instead of an image.

Details in [`patches/README.md`](patches/README.md).

</details>

### Let DSH install it for you

If you'd rather not type, hand DSH this block whole — it has bash and will run it:

```text
Install dsh-design-qa. Five steps, exactly as written, don't improvise:

1. dsh plugin --profile web add dsh-design-qa
2. cd "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-design-qa"
3. export BAILIAN_API_KEY=<your key>      # use export; the next command needs it too
4. node install.mjs --route-only
5. node install.mjs --restart      # do NOT use pkill, that kills you

Step 4 also edits DSH core in three places (required for pasting images). Originals are
backed up automatically and `node install.mjs --revert-patches` undoes all of it.
Paste step 4's full output back to me.
```

**Keep the "don't improvise" line.** Three things go wrong when an agent freelances:

- **Dropping `--route-only`** — it writes a plugin row that duplicates the one the bundle already
  provides, and DSH throws `duplicate loader entry id` at startup: **the whole profile fails to
  boot**. The script guards against this, but not every agent reads the message.
- **Restarting with `pkill`** — the agent is usually running *inside* the process it is about to
  kill, so killing it is suicide: it never sees the result and cannot confirm success.
  `--restart` returns immediately and the restart completes behind it.
- **Inventing a key** — the script never handles secrets. The self-check will say
  `BAILIAN_API_KEY` is missing, and the agent should come back and ask you for it.

**A failed core patch exits non-zero**; a missing key or unwritten route is a yellow warning in the
self-check (exit code still 0). So don't judge by exit code alone — have the agent paste the output
back and look for yellow text in the final section.

> DSH's self-modification tools (`cordis_define` / `cordis_run`) **cannot** do a persistent install.
> They are in-memory: no plugin file, no change to `cordis.yml`, gone on restart. A persistent
> install has to reach disk, which is why the steps above.

---

## Why Qwen: it passed the benchmark

Not a coin flip. [`eval/`](https://github.com/sunxin-ai/dsh-design-qa/tree/main/eval) holds the full
benchmark spec and four fixtures (23 defects). Cross-model results:

| Model | Targeted probes | Hard tier (font-weight 800 vs 500) |
|---|---|---|
| **`qwen3.8-max`** | **24/24** | **12/12, direction always right** |
| `qwen3-vl-plus` | 21/24 | 1/4 |
| `moonshot-v1-128k-vision` | 18/24 | 8/15 ≈ chance |

Zero-difference control (pair a mock with itself; any reported difference is a hallucination):
**`qwen3.8-max` called all 6 identical, 0 hallucinations.**

`qwen3.8-max` is the only one that holds up on the hard tier. The other two are coin flips on
font-weight direction — and **a confidently wrong direction is more dangerous than a miss**,
because it sends the fix the wrong way.

## Using a different model

**The defaults are only defaults.** Nothing about the model is hardcoded. Two config changes:

```yaml
# 1) $DSH_HOME/settings.yaml — add your own route
llm-pi-ai:
  providers:
    my-vision:
      api: openai-completions
      baseURL: https://your-endpoint/v1
      apiKeyEnv: MY_VISION_API_KEY
      models:
        - id: your-model-id
          input: [text, image]      # ← required, or the gate refuses it
```

```yaml
# 2) the profile's cordis.patch.yml — override the plugin row's config
- id: design-qa
  config:
    provider: my-vision
    model: your-model-id
```

**Do not write `- insert:` here.** The bundle layer already inserted the plugin row; a second
`insert` with the same id does not override it, it **coexists**, and DSH throws
`duplicate loader entry id: design-qa` at startup. The form above — an `id` plus the fields you
want changed — is what overrides by id.

**The one hard requirement: the model must genuinely accept image input, and the route must declare
`input: [text, image]`.** That is "a claim about the endpoint, not a check of it" (upstream's own
JSDoc) — declaring images an endpoint refuses fails at call time, not at config time.

After switching, re-run [`eval/`](https://github.com/sunxin-ai/dsh-design-qa/tree/main/eval)
(GitHub only, not shipped in the package), and look hardest at the hard tier and the zero-difference
control: **seeing is not the same as usable.** A model with good recall but frequent hallucinations,
or one whose verdicts drift between runs, makes the judgement loop diverge instead of converge.

## The tool

### `deepseek_vision(image_path, question)`

Look at one image and answer a question about it. `image_path` takes one of three forms:

- an absolute file path
- an **http(s) image URL** — images in docs and web pages go in directly. Honors the system proxy
  (`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`), caps at 20 MB, follows redirects
- an attachment id from a `[图片 …]` pointer in context (`attachment=<id>` or the bare id)

**The tool refuses when the caller is itself multimodal** — it sees better and cheaper directly, and
relaying through another model loses information. This doubles as the hand-off for the day official
multimodal ships: when DeepSeek declares `image`, this tool bows out on its own.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `provider` | `bailian` | Vision route name; must declare `input: [text, image]` |
| `model` | `qwen3.8-max` | Vision model |
| `maxTokens` | `4000` | Output cap for one look |
| `reasoningEffort` | `off` | Readout questions don't need a chain of thought |

## How you ask decides whether it works

Measured, not a style preference. Full version in
[`skills/design-qa/SKILL.md`](skills/design-qa/SKILL.md).

| Question form | Hallucinations on zero-diff control | Hard-tier recall |
|---|---|---|
| "find the differences yourself" | 0/30 | 0/2 |
| "is there a difference in this respect" | 0/30 | 0/2 — a yes/no question; the model defaults to no |
| "which one is larger" | 0/36 | 1/2 — whitespace cases answered backwards 3/3 |
| **"what is each one's value"** | **0/12** | **2/2** |

Same model, same images: **recall went from 0/2 to 2/2 with hallucinations at zero throughout.**
Only the phrasing changed.

**Direction is trustworthy, magnitude is not**: true weights 800/500 read as 800/700; spacing 80/25
reads as 72/38 — the measured side is always pulled toward the reference. Use it to decide *whether*
there's a difference and *which way*, never as a measurement. Get exact values on the implementation
side with `getComputedStyle` or pixel measurement.

## Cost

Image tokens ≈ pixels / 1024 (measured 1023–1127 px/token, independent of aspect ratio).

| | Mean | Range |
|---|---|---|
| One judgement | ¥0.037 | ¥0.027 – 0.051 |
| Latency | 9.0s | 6.6 – 11.6s |

**About four cents an image.** Estimated at ¥12/M input and ¥36/M output — check current pricing in
the console before you rely on it.

## When it should retire

The day DeepSeek officially declares `image` in `inputModalities`.

Nothing needs changing then: `deepseek_vision` will find that the caller can see images itself,
**refuse and step aside**, and images will flow into the model's context through the native path.
The patches and the plugin can be left exactly as they are, or removed.

## When not to use this

If you just want to glance at an image — **modlens is less work**: zero config, no core changes.

This plugin is built for **judging design-implementation fidelity**, where every conclusion has to
trace back to evidence. That is why it is worth an extra route and three core edits: images travel
the native path, and the judgement can be replayed. If you don't need that guarantee, those costs
are pure overhead.

---

## Reference

### Every `install.mjs` switch

```sh
node install.mjs [profile]         # full install (use this when not going through dsh plugin add)
```

| Switch | Effect |
|---|---|
| `[profile]` | Target profile, defaults to `web` |
| `--route-only` | Don't write the plugin row. **Required if you installed via `dsh plugin add`**, see below |
| `--no-patches` | Leave DSH core alone. Pasting images stays refused |
| `--revert-patches` | Undo the core patches and exit |
| `--restart` | Cold restart only; safe to call from inside dsh's own process |
| `--force` | Ignore the pre-restart checks |

Environment variables (all only needed when auto-detection fails):

| Variable | Effect |
|---|---|
| `DSH_HOME` | DSH's home directory, defaults to `~/.dsh` |
| `DSH_REPO` | DSH source repo root. Only if core auto-location picks the wrong one |
| `DSH_PROCESS_PATTERN` | Command-line fragment identifying the dsh process |
| `DSH_CWD` | dsh's working directory. **Required on Windows** — no `/proc`, no `lsof` there |
| `DSH_RESTART_CMD` | dsh's full launch command |

A full install does six things, all idempotent, each backing up before it writes: symlink
`node_modules` → symlink the skill → write the vision route → write the plugin row → patch core in
three places → self-check.

### After `dsh plugin add`, `--route-only` is not optional

Without it the installer writes another row with the same id into the profile's `cordis.patch.yml`,
colliding with the one the bundle provides. DSH throws
`duplicate loader entry id: design-qa` at startup and **the whole profile fails to boot** — not a
plugin load failure, dsh simply doesn't start. (The script guards against this: it skips the write
when it detects the package is already installed as a bundle.)

### A cold restart is required after installing

**HMR is off.** Plugins, skills, profile patches, and core edits are all load-time.
**Reloading the browser does not count**:

```sh
node install.mjs --restart
```

It reads the original launch command and working directory out of the running process before
relaunching, so it won't lose the `--patch` arguments you started with. And it **returns
immediately**, which is what makes it safe for an agent running inside dsh to call (`pkill` would
take the agent down with it).

The new process **inherits the caller's current environment**. Three checks run *before* anything is
killed; if any fails, it stops and leaves the old process alive (`--force` overrides):

- the `node` that would actually run doesn't satisfy DSH's `^22.19 || >=24`;
- the old process holds secret-looking environment variables the current shell doesn't (say a
  `BAILIAN_API_KEY` exported only in another terminal) — losing one leaves the plugin
  "installed but unusable". Only names are compared, never values;
- the launch command came back mangled. On Linux the exact argv is read from `/proc` and is
  unaffected; elsewhere only a space-joined command line is available, which splits wrongly when an
  argument contains spaces — pass `DSH_RESTART_CMD` explicitly in that case.

The new process's output goes to `$DSH_HOME/dsh-design-qa-restart.log`.

**On Windows** you must also pass `DSH_CWD`, or the working directory can't be read and the restart
is refused.

### Editing the plugin source

Changes to `src/index.ts` have to be built into `lib/index.js` — that's what DSH loads:

```sh
npx tsdown --entry src/index.ts --format esm --out-dir lib --dts false --no-config
```

Note that step 1 of `install.mjs` replaces this directory's `node_modules` with a symlink into the
profile, and `npm install` replaces it back with a real directory — the two fight each other. Run
the build tool through `npx`, or install it elsewhere; don't `npm install` into this directory.

### What the vision route looks like

`install.mjs` writes this into `$DSH_HOME/settings.yaml`. By hand:

```yaml
llm-pi-ai:
  providers:
    bailian:
      displayName: 阿里百炼
      apiKeyEnv: BAILIAN_API_KEY      # variable name only; the key never hits disk
      api: openai-completions
      baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
      compat:
        thinkingFormat: qwen          # required, see below
      models:
        - id: qwen3.8-max
          input: [text, image]        # ← the line that opens the image gate
          contextWindow: 262144
          maxTokens: 8192
          reasoningEfforts:
            off:
            high: high
```

`input: [text, image]` becomes `LlmModel.inputModalities`, which is exactly what DSH's image gate
reads.

**`thinkingFormat: qwen` is not optional.** With thinking left on, a single readout produces 5000+
characters of reasoning (1582 output tokens; 14 with it off) and returns **the same reading** —
113× of pure waste.

### Uninstalling

```sh
node install.mjs --revert-patches                # 1. undo the core patches first
dsh plugin --profile web remove dsh-design-qa    # 2. the plugin row
rm -rf ~/.agents/skills/design-qa                # 3. the skill link (may be a copied directory on Windows)
# 4. delete the llm-pi-ai.providers.bailian block from $DSH_HOME/settings.yaml
```

**Step 1 is mandatory and must come first.** Leave only the serialization patches in place and the
model will be told to call a tool that no longer exists; remove the plugin first and
`--revert-patches` goes away with it.

## Known limitations

- **The core edits can't disable themselves.** They are file changes on disk, and uninstalling a
  plugin only removes the plugin row — it doesn't rewrite those files. So uninstalling requires an
  explicit `--revert-patches`, in the order given above.
- **Upgrading DSH wipes the core edits** (the files are replaced by the new version). The symptom is
  "pasting is refused again"; re-run `node install.mjs --route-only`. This is deliberate: if a newer
  DSH supports images on its own, the patches should not quietly linger. Even if the backup files
  survive an upgrade, `--revert-patches` will only clear the stale backup — it will not overwrite
  the new files with old content.
- **Anchors are located by code shape, not by version number.** If upstream rewrites any of the
  three sites, the script **fails and names the file** rather than applying half a patch. Every form
  present is patched (`src/*.ts` for source checkouts, `lib/index.js` for npm installs) — there is
  no reliable way to tell which one is live, so both get changed; a source checkout therefore gains
  a few untracked `.dsh-design-qa-orig` backup files.
- **The `attachment=<id>` form is process-local**: the id → path index lives in memory and is gone
  after a restart. Use a file path instead.
- **No multi-image comparison**: `deepseek_vision` looks at one image per call. Side-by-side
  mock-vs-implementation composites have to be assembled by the caller.
- **Images behind a login can't be fetched**: URLs from Feishu, Notion and the like return 401/403.
  Download them locally with the appropriate skill first and pass the path. The tool says so in its
  error message, but it has no built-in credential path.
- **The self-check matches loosely**: `settings.yaml` is maintained by DSH's own settings writer and
  gets normalized, so the check only looks for something that resembles a configured route — it does
  not verify the fields are semantically correct.
