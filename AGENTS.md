# Agent Instructions

## Project management with Kanbus

Use Kanbus for task management.
Why: Kanbus task management is MANDATORY here; every task must live in Kanbus.
When: Create/update the Kanbus task before coding; close it only after the change lands.
How: See CONTRIBUTING_AGENT.md for the Kanbus workflow, hierarchy, status rules, priorities, command examples, and the mistakes to avoid. Never inspect project/ or issue JSON directly (including with cat or jq); use Kanbus commands only.
Performance: Prefer kbs (Rust) when available; kanbus (Python) is equivalent but slower.
Warning: Editing project/ directly violates The Way. Do not read or write anything in project/; work only through Kanbus.
Git / PR policy: Rules for product-code commits, branch names, pull requests, and human approval live in this repository's AGENTS.md (outside this Kanbus section). CONTRIBUTING_AGENT.md covers Kanbus board mechanics such as `kbs commit`; follow AGENTS.md for product code and git workflow.

## Git policy

- Work happens on `master`. Commit once per reviewed Kanbus task, with the task ID in the message (e.g. `apricity-a1b2c3: add the contract generator`).
- After changing cards, run `kbs commit` so the board state is committed too.
- Sub-agents working a task never commit, push, or close issues; the reviewer (the agent that filed the task) does, after re-running the task's verification.
- Never push or publish (git remotes, crates.io, PyPI, npm, AWS deploys) without the user's explicit go-ahead.
- Keep large data out of git: audio under `samples/` and `renders/` is ignored; only analysis manifests are tracked.

## Other working areas

- The web UI (`web/src/ui/*`, `web/src/style.css`), `docs/` and branding belong to a separate web/docs session. Storage work may change how the UI fetches data, but coordinate visual/UX changes through the Kanbus issue rather than making them directly.
- Virtuus (`~/Projects/Virtuus`, Kanbus key `virt`) is upgraded upstream for the storage engine; follow its own AGENTS.md there (specs first, 100% coverage, Python/Rust parity, feature branches off `develop`).

