# Agent Instructions

## Project management with Kanbus

Use Kanbus for task management.
Why: Kanbus task management is MANDATORY here; every task must live in Kanbus.
When: Create/update the Kanbus task before coding; close it only after the change lands.
How: See CONTRIBUTING_AGENT.md for the Kanbus workflow, hierarchy, status rules, priorities, command examples, and the mistakes to avoid. Never inspect project/ or issue JSON directly (including with cat or jq); use Kanbus commands only.
Performance: Prefer kbs (Rust) when available; kanbus (Python) is equivalent but slower.
Warning: Editing project/ directly violates The Way. Do not read or write anything in project/; work only through Kanbus.
Git / PR policy: Rules for product-code commits, branch names, pull requests, and human approval live in this repository's AGENTS.md (outside this Kanbus section). CONTRIBUTING_AGENT.md covers Kanbus board mechanics such as `kbs commit`; follow AGENTS.md for product code and git workflow.

Kanbus board commits are **project management, not product**. After `kbs` create/update/comment/close, run `kbs commit`, commit those files on `develop` and push `origin develop`. **Do not open a pull request.** Do not use a feature branch or worktree. Do not wait for CI or a reviewer. A PR is for product behavior and production code. Do not mix board files into a product PR: land the board on `develop` first.

## Git policy (Git Flow and Semantic Release)

- `develop` is the integration branch. Merge accepted, green work there as soon as it is ready. Do not park completed work on long-lived feature branches waiting for `main`.
- `main` is the release branch only. Semantic Release runs only from `main`. Do not treat a merge to `develop` as a release. Promote `develop` to `main` when you intend a release. Do not merge product work straight to `main`.
- Bots and coding agents may commit and push to `develop`, and open pull requests into `develop` (not `main`) for product work. Merge a PR as soon as review is addressed and CI is green.
- Commit once per reviewed Kanbus task. Semantic Release computes versions from commit messages, so use Conventional Commits with the task ID as the scope (e.g. `feat(apricity-a1b2c3): add the contract generator`, `fix(apricity-a1b2c3): ...`). Breaking changes carry a `!` or a `BREAKING CHANGE:` footer.
- Sub-agents working a task never commit, push, or close issues; the reviewer (the agent that filed the task) does, after re-running the task's verification.
- Releases and publishing (crates.io, PyPI, npm, AWS deploys) happen only through the Semantic Release workflow on `main`, not by hand from a local shell.
- Keep large data out of git: audio under `samples/` and `renders/` is ignored; only analysis manifests are tracked.

## Other working areas

- The web UI (`web/src/ui/*`, `web/src/style.css`), `docs/` and branding belong to a separate web/docs session. Storage work may change how the UI fetches data, but coordinate visual/UX changes through the Kanbus issue rather than making them directly.
- Virtuus (`~/Projects/Virtuus`, Kanbus key `virt`) is upgraded upstream for the storage engine; follow its own AGENTS.md there (specs first, 100% coverage, Python/Rust parity, feature branches off `develop`).

