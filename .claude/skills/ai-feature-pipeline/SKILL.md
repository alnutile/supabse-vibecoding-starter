---
name: ai-feature-pipeline
description: >-
  Build an in-app "idea → shipped code" board where the app improves itself: anyone
  files a feature request or bug (with screenshots), an admin drags the card to
  approve it, an AI coding agent (Claude Code, in GitHub Actions) implements it on a
  branch and opens a PR, and dragging the card again squash-merges the PR — and merge
  = deploy. Use when the request is about a "features board", "roadmap kanban",
  "self-improving app", "let users request features the AI builds", "idea to PR",
  "AI opens a pull request", "trigger a coding build from inside the app", or
  connecting an in-app board to GitHub issues/PRs. Triggers: "features board",
  "kanban that builds itself", "AI builds the feature", "approve for work",
  "self-building app", "idea to shipped", "GitHub PR from a card".
---

# AI Feature Pipeline — the app that builds itself

A kanban board *inside* your app that turns a plain-language idea into shipped,
reviewed code. It is the loop that lets a team (or a customer) say "I wish it did
X" and get X — without anyone opening an editor — while a human stays on the two
levers that actually matter: **spend AI effort** and **ship to production**.

```
 Ideas            Approved for work        Approved to merge         Shipped
 (anyone files)   (admin drags here)       (admin drags here)        (merged)
      │                   │                        │                    │
      │  admin approves   │  Claude Code builds    │  squash-merge PR   │
      └──────────────────▶│  it on a branch,       │  = deploy          │
                          │  opens a PR ───────────▶ (Railway + CI)     │
                          └────────────────────────┴────────────────────┘
        the two human approvals ARE the drag moves. The AI never touches main.
```

## The one idea

**The pull-request review is the security boundary.** Feature text is
attacker-reachable (anyone with an account — or the public, if the repo is public —
can write a card). Production code is not. Between them sits a PR that a trusted
human reads and merges. So the AI is allowed to write *anything* onto a branch,
and none of it becomes real until a human moves the card to "Approved to merge."
Design every part of this feature to preserve that boundary. Never let the agent
push to `main`.

## When to build this

Build it once the base app exists (auth + a database + RLS — the things this
starter already ships) and you want the app to grow itself. It is a **capstone**
feature, not a phase-1 feature: it depends on real accounts, an admin role, and a
GitHub repo whose merges deploy.

## What it's made of (7 parts)

| Part | What it does | In this starter |
|---|---|---|
| `features` table + RLS | one row per idea; lanes `idea→approved→ready→shipped`; anyone files, only admins move | `references/build-spec.md` §1 |
| Realtime | the board is live — PR links land asynchronously | added to the publication, §1 |
| Board UI | drag-to-move kanban, screenshot upload, PR badges | `FeaturesBoard.tsx`, §4 |
| Pure list helpers | `upsertFeature` / `removeFeature` for the realtime merge (unit-tested) | drop-in, §3 |
| `features` edge function | the GitHub brain: `approve` / `sync` / `merge` | §2 |
| Claude Code workflow | fires on the label, builds the feature, opens a PR, runs CI on the branch | `.github/workflows/claude-feature.yml`, §5 |
| Admin trust boundary | who may approve/merge (spend $ / ship) | minimal `profiles.is_admin`, §1 |

## How to build it here (read these in order)

1. **`references/concept.md`** — the mental model, the four lanes as a state
   machine, and *why the PR review is the security boundary*. Read this first; it
   is the part you most want the AI to internalize.
2. **`references/github-flow.md`** — the exact GitHub mechanics: the
   `approved-for-work` label, how the Claude Code Action is wired (OpenRouter
   billing, the `gh` auth gotcha), and how the board discovers the PR from the
   issue's timeline. The API calls, verbatim.
3. **`references/build-spec.md`** — the step-by-step build **adapted to this
   starter's conventions** (plain CSS, no router, timestamp-prefixed migrations,
   an edge-function secret instead of a vault). Copy-paste SQL/TS.
4. **`origin-source/`** — the *real, production* source this was extracted from
   (the [supabase-as-a-service](https://github.com/alnutile/supabase-as-a-service)
   intranet). Ground truth to compare against. `origin-source/ORIGIN.md` maps each file
   to the adapted version and flags what changed and why.

## Non-negotiables (carry these from `vibe-coding-with-confidence`)

- **The agent works on a branch and opens a PR. It never pushes to `main`.** Rely
  on that + branch protection on `main`.
- **Only an admin can approve or merge.** Approving opens a (possibly public)
  GitHub issue and spends AI credits; merging deploys to production. Both are
  admin-gated in the edge function *in code*, not just hidden in the UI.
- **The GitHub token is server-only.** It lives as an edge-function secret (or a
  vault), never in the browser, never in a `VITE_` var, never in git.
- **Public repo = public issue.** Approving a card copies its title, description,
  and screenshots into a GitHub issue. On a public repo that is world-readable the
  instant it opens. The UI must warn before approving; screenshot signed-URLs must
  be short-lived.

## Deploy gotcha: Vite preview + Railway host-check

`npm start` serves the production build with `vite preview`, whose host-check
returns **403 "This host is not allowed"** for any `Host` it doesn't recognise —
and that is every Railway domain by default, so a fresh deploy 403s on first
load even though the build is green. The fix lives in `vite.config.ts`:

```ts
preview: { allowedHosts: ['.up.railway.app'] }
```

The leading dot allows the generated `*.up.railway.app` domain for **any**
project spun from this template — no per-project edit. Add a custom domain to
the list if you map one. Keep this in `vite.config.ts` so every feature this
pipeline ships (merge = deploy) lands live instead of 403-ing.

## Definition of done

- [ ] A non-admin can file an idea but **cannot** move a card (verified as a second user).
- [ ] Approving opens a labeled issue; the workflow builds it and a PR appears on the card.
- [ ] The PR runs the same CI (`typecheck`/`lint`/`test`/`build`) as `main` — green means "a PR exists and passes", not "the agent didn't crash".
- [ ] Dragging to "Approved to merge" squash-merges and deploys; the card lands in Shipped.
- [ ] The GitHub token is server-only; approving a card on a public repo warns about visibility.
