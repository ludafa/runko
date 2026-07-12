Writes a Conventional Commits message summarizing a git diff in one imperative-mood sentence.

## Usage

Given a git diff, produce a commit message with a `type(scope): summary` header line, choosing `type` from
`feat|fix|refactor|docs|test|chore` based on what the diff actually does. Keep the summary under 70 characters.
Add a body only when the "why" isn't obvious from the header alone.
