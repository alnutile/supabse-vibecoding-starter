# The concept: an app that improves itself, safely

## The loop

1. **Someone has an idea** — "clicking a skill in chat should arm it, not send a
   message." They file it on the board (title, description, optional screenshots).
   Anyone with an account can do this. The description is read *verbatim* by the
   coding agent, so it should say **where** the change happens and what **"done"**
   looks like.
2. **An admin approves it** by dragging the card to **Approved for work**. That
   move opens a GitHub issue labeled `approved-for-work`.
3. **The AI builds it.** A GitHub Action fires on that label, runs **Claude Code**
   against a fresh checkout of the repo, implements the change on a branch named
   `feature/issue-<n>`, verifies it (`npm run build`, `npm test`), and opens a
   **pull request** whose body contains `Closes #<n>`.
4. **The board tracks the PR.** The edge function's `sync` action finds the PR from
   the issue's timeline and shows its state on the card (open / merged / closed).
5. **An admin ships it** by dragging the card to **Approved to merge**. That
   squash-merges the PR. Merging `main` *is* deploying — Railway rebuilds the app,
   and the migrations/functions deploy workflows run.
6. The card lands in **Shipped**.

## The four lanes are a state machine

| Lane | Who moves it here | Side effect |
|---|---|---|
| `idea` | anyone (on insert) | none — just a row |
| `approved` | **admin** | `features` fn → open GitHub issue (label `approved-for-work`) |
| `ready` | **admin** | `features` fn → squash-merge the linked PR |
| `shipped` | the system (`sync`/`merge`) | none — terminal, set when the PR is merged |

Two of those transitions are **human approvals**, and they are the only two that
cost anything:

- **`idea → approved`** spends AI effort (and, on a public repo, publishes the
  card). A human decides the idea is worth building.
- **`ready → merge`** ships code to production. A human decides the *PR* is worth
  merging.

Everything else (filing ideas, the AI building, syncing PR state) is cheap and
reversible. Concentrate the guardrails on those two moves.

## Why this is safe: the PR is the boundary

The feature text is **attacker-reachable**. On a team app, any member can write a
card; on a public-facing one, potentially anyone. That text flows straight into
the coding agent's prompt. So treat the agent's output as **untrusted** until a
human vouches for it:

```
  attacker-reachable                     trusted
  ┌─────────────────┐   PR review   ┌──────────────────┐
  │ card text ──▶ AI │ ────────────▶ │ code on main     │
  │ writes a branch  │   (a human    │ deploys to prod  │
  │ + opens a PR     │    merges)    │                  │
  └─────────────────┘               └──────────────────┘
```

The agent may write *anything* onto a branch — it cannot hurt production, because:

1. **It never pushes to `main`.** The workflow only lets it push a feature branch
   and open a PR. Add branch protection on `main` so even a bug in the workflow
   can't merge without review.
2. **Merging is a separate, admin-only, human action** (the "Approved to merge"
   drag), performed after reading the PR.
3. **The same CI that guards `main` runs on the agent's branch.** "Green" must mean
   "a PR exists and its tests pass," never "the agent process exited 0."

If you remember one thing: **do not collapse those two steps.** An auto-merge on
green would hand production to whoever can write a card.

## The admin trust boundary

Approving and merging must be restricted to people you trust with **spend** and
**production**. This starter has open sign-up and no roles, so the feature adds the
smallest possible role: a `profiles` row per user with an `is_admin` flag, first
signup = admin (see `build-spec.md` §1). If your app already has roles, reuse them.

The gate is enforced **in the edge function, in code** — not merely by hiding the
drag handles in the UI. A hidden button is not a permission; RLS + a server-side
`is_admin` check is.

## The public-repo caveat (don't skip)

Approving a card calls the GitHub API to open an issue containing the card's
**title, description, and screenshots**. If the repo is public, that issue is
world-readable the moment it opens, and GitHub proxies rendered images through its
`camo` cache — so treat anything you screenshot as **published** on approval. Two
mitigations, both in the reference implementation:

- The UI shows a `confirm()` warning before approving that spells out the exposure.
- Screenshot links in the issue are **short-lived signed URLs** (24h), so the TTL
  at least bounds *new* reads of the original private file.

For a private repo this is a non-issue, but build the warning anyway — templates
get cloned into public repos.

## What "generic" means here

Portable across any stack: the **lane state machine**, the **approve/sync/merge**
edge-function shape, the **label → Action → PR** GitHub flow, and the
**upsert/remove** realtime helpers. What's stack-specific: the UI framework, how
you store the token (vault vs. edge secret), and how your merges deploy. The
build-spec adapts those to this starter; `github-flow.md` keeps the portable core.
