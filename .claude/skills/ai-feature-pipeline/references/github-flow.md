# The GitHub mechanics (the portable core)

This is the part that is the same on any stack. Three moving pieces talk to GitHub:
the **edge function** (approve / sync / merge), a **label**, and a **GitHub Action**
running Claude Code.

## The contract

- A single label, **`approved-for-work`**, is the trigger. Create it once in the
  repo (`gh label create approved-for-work`). Opening an issue with this label is
  what kicks off a build; nothing else does.
- A branch naming convention, **`feature/issue-<n>`**, ties an issue to its branch
  so the "verify a PR exists" step can look it up deterministically.
- The PR body must contain **`Closes #<n>`** so GitHub links the PR to the issue —
  that link is how the board rediscovers the PR (`sync`).

## 1. `approve` — open the issue

The edge function (admin-only) reads the feature row and POSTs a new issue:

```
POST /repos/{owner}/{repo}/issues
{
  "title":  feature.title,
  "body":   "<description>\n\n## Screenshots\n![](<24h signed url>) …\n\n<!-- feature:<id> -->",
  "labels": ["approved-for-work"]
}
```

- Screenshots are turned into **short-lived (24h) signed URLs** from the private
  bucket and embedded as markdown images.
- An HTML comment `<!-- feature:<id> -->` stamps the board row id into the issue for
  traceability.
- On success, store `issue_number` on the row and move it to `approved`. Guard
  against double-approval (`if (feature.issue_number) return 400`).

## 2. The Claude Code Action builds it

`.github/workflows/claude-feature.yml`, triggered `on: issues: types: [labeled]`,
guarded by `if: github.event.label.name == 'approved-for-work'`.

Key wiring, learned the hard way:

- **Route Claude Code through OpenRouter** so the build runs on OpenRouter billing,
  not an Anthropic key. The action's pre-flight rejects an empty `anthropic_api_key`,
  and Claude Code's auth precedence prefers `ANTHROPIC_AUTH_TOKEN` (an
  `Authorization: Bearer` header) over the api key (`X-Api-Key`). OpenRouter wants
  Bearer. So pass the OpenRouter key as **both**, and set the base URL:

  ```yaml
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}          # gh CLI reads THIS, not github_token
    ANTHROPIC_BASE_URL: https://openrouter.ai/api
    ANTHROPIC_AUTH_TOKEN: ${{ secrets.OPEN_ROUTER_KEY }}
  with:
    anthropic_api_key: ${{ secrets.OPEN_ROUTER_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
  ```

  > The `GH_TOKEN` env var is not optional: the action wires up *git* auth itself,
  > but the `gh` CLI (`gh pr create`) reads `GH_TOKEN` from the environment. Without
  > it, `gh pr create` fails silently and the branch never gets a PR.

- **The prompt tells the agent the rules**: read `CLAUDE.md` first, work on
  `feature/issue-<n>`, run `npm install` then `npm run build` **and** `npm test`
  (add tests if it changed logic), add a numbered migration if the schema changes,
  commit + push the branch, open a PR whose body contains `Closes #<n>`, and — in
  bold — **do NOT push to main, do NOT merge.**

- **`claude_args`** bounds the run: a model, `--max-turns`, and an `--allowedTools`
  allow-list (`Bash(git:*),Bash(npm:*),Bash(gh:*),Read,Write,Edit,Glob,Grep`).

## 3. Verify a PR exists, then run CI on the branch

Two follow-up steps, and the order matters:

1. **Verify a PR was opened** *first*. If the agent finished without pushing +
   opening a PR (e.g. it ran out of turns before committing), comment the failure
   on the issue and `exit 1` with a clear message — otherwise the next step fails
   confusingly on a `git fetch` of a ref that was never pushed.

   ```bash
   pr=$(gh pr list --repo "$GITHUB_REPOSITORY" --head "feature/issue-<n>" \
        --state open --json number --jq '.[0].number // empty')
   [ -z "$pr" ] && { gh issue comment <n> --body "⚠️ finished without a PR"; exit 1; }
   ```

2. **Run the same CI as `main` on the branch.** PRs opened with the workflow's
   `GITHUB_TOKEN` do **not** trigger `pull_request` workflows (GitHub anti-recursion),
   so your normal CI will *not* run on the bot's PR. Re-run it here, deterministically:

   ```bash
   git fetch origin "feature/issue-<n>" && git checkout "feature/issue-<n>"
   npm ci && npm run typecheck && npm run lint && npm test && npm run build
   ```

   Red here means "don't merge." This is what makes "green" trustworthy.

## 4. `sync` — discover and refresh the PR

The board doesn't know the PR number until the agent opens one. Find it from the
issue's **timeline cross-references**:

```
GET /repos/{owner}/{repo}/issues/{issue_number}/timeline?per_page=100
  → find the last event where event === 'cross-referenced'
    and source.issue.pull_request exists → that's the PR (number + html_url)
```

Then `GET /repos/{owner}/{repo}/pulls/{pr_number}` for its state
(`data.merged ? 'merged' : data.state`). Persist `pr_number` / `pr_url` /
`pr_state`; if merged, move the card to `shipped`. Call `sync` when the board opens
(for in-flight cards) and right before a merge. Because the PR link lands
asynchronously, **the board must be Realtime-subscribed** or the link only appears
after a manual reload.

## 5. `merge` — squash-merge the PR

The "Approved to merge" drag. Sync first (so you merge the *real* linked PR), then:

```
PUT /repos/{owner}/{repo}/pulls/{pr_number}/merge   { "merge_method": "squash" }
```

On success, move to `shipped`, `pr_state = 'merged'`. On failure, write `last_error`
onto the card and drop it back so the human can retry. Merging `main` is what
triggers your deploy (Railway rebuild + the migrations/functions deploy workflows).

## Auth & secrets summary

| Secret | Where | Used by |
|---|---|---|
| GitHub token (repo + issues + PR scope) | **server-side only** — edge-function secret `GITHUB_PAT` (or a vault) | the `features` edge function's API calls |
| `OPEN_ROUTER_KEY` | GitHub **Actions** secret | Claude Code in the workflow |
| `GITHUB_TOKEN` | provided by Actions automatically | the workflow's git/PR/label operations |

The GitHub token the *edge function* uses is a **different** token from the
workflow's built-in `GITHUB_TOKEN`. The edge function needs its own PAT (or a fine-
grained token) with permission to create issues, read PRs/timelines, and merge PRs.
