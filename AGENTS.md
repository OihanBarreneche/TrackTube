# Agent commit attribution

Before making a commit, set this repository's local Git identity to the agent
that actually made the change, and verify both author and committer. Never use
the maintainer's Git identity for an agent-created commit.

- Codex: `Codex (GPT-6) <codex@users.noreply.github.com>`
- Claude Code: `Claude Code <noreply@anthropic.com>`

Use `git config --local user.name` and `git config --local user.email` when
switching agents, then check `git var GIT_AUTHOR_IDENT` and
`git var GIT_COMMITTER_IDENT` before committing. Do not change the identity of
commits the maintainer actually authored.
