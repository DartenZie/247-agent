---
name: report-github-issue
description: Use when the user asks to draft or file a GitHub issue for a bug, feature request, or documentation problem. Selects the matching template and type label, checks for duplicates, and creates the issue when requested.
---

# Report GitHub issue

Turn the user's report into a concise GitHub issue. Keep the title separate from the
body. Every body section uses an H3 heading, including the summary; do not add a
`Description` wrapper.

## Select the template

Read only the file matching the request. Each file defines its title guidance and
body structure; the table below defines the type labels.

| Type | Use when | Label | Template |
| --- | --- | --- | --- |
| Bug report | Existing behavior fails to meet expectations | `bug` | [bug-report.md](bug-report.md) |
| Feature request | Users need new or improved functionality | `enhancement` | [feature-request.md](feature-request.md) |
| Documentation | Written guidance is missing, incorrect, outdated, or unclear | `documentation` | [documentation.md](documentation.md) |

Choose one primary type per issue. Ask if the intended change is ambiguous, such as
whether to correct the software or its documentation. Separate independent requests
into separate issues.

## Gather and write

1. Extract the available facts from the conversation, attachments, and relevant
   repository context. Resolve the target repository from the user's request or the
   current checkout; ask if multiple repositories plausibly match.
2. Ask in one round for missing information needed to understand or act on the
   request. For nonessential missing facts, retain the section and write `Unknown`.
   Use `Not applicable` only when a field genuinely does not apply. Never invent
   reproduction steps, frequency, environment, user counts, or business impact.
3. Fill the selected template in its stated order. Replace all angle-bracket
   instructions with issue content. Omit sections explicitly marked optional when
   there is nothing to include. Use a short, specific title without a type prefix
   or trailing period.

## File and verify

1. Before filing, search the target repository's open and closed issues for the
   same symptom or requested outcome. If a likely duplicate exists, show its link
   and explain the overlap before asking whether a separate issue is needed.
2. Check that the type label exists. If it is missing, ask whether to create it or
   use an existing equivalent; do not silently omit or substitute it.
3. For a draft request, return the title, rendered body, repository, and label
   without creating an issue. An explicit request to file or create the issue
   authorizes creation once the required information is available. Honor any
   user request to review the draft first.
4. Create the issue using an available GitHub connector or authenticated GitHub
   CLI. Apply the selected type label. Set assignees, milestones, projects, or
   additional labels only when requested. If creation is unavailable, return the
   complete draft and explain what prevented filing.
5. Re-read the created issue and verify its repository, title, body headings and
   order, and label against the draft. Return its number and URL, and disclose
   any verification failure. If creation returns an ambiguous result, check for
   the issue before retrying to avoid creating duplicates.
