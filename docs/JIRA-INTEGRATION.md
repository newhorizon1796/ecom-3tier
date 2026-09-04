# Jira integration

This project tracks work in Jira Cloud (an existing account works fine —
the site's login email is unrelated to which GitHub account you connect
it to; the two are linked via OAuth, not by matching emails).

## 1. Create the project

In Jira: **Create project** → Kanban (or Scrum, either works for this) →
key `ECOM`. The key matters — every issue becomes `ECOM-1`, `ECOM-2`, …,
and that's what the rest of this doc and every repo's PR template
reference.

## 2. Install the GitHub for Jira app

This is what links commits, branches, and PRs across all five repos back
to their Jira issue, automatically, once the issue key appears in a
commit message or branch name.

1. In Jira: **Apps → Explore more apps** → search "GitHub for Jira" → install.
2. Follow its setup flow to authorize against your GitHub account — it
   asks which repos to connect. Select all five:
   `ecom-frontend`, `ecom-backend`, `ecom-infra`, `ecom-k8s`,
   `ecom-monitoring` (and this hub repo, `ecom-3tier`, if you want its
   docs-only commits linked too).
3. This is a one-time OAuth authorization against the GitHub account —
   it does not care what email the Jira site itself uses.

## 3. Enable Smart Commits

Jira project **Settings → Smart Commits** (or, if not visible, it's
enabled by default on Cloud — the app just needs to be installed first).
Once on, a commit message like:

```
ECOM-12 #comment added the Stripe checkout route #time 1h
```

posts a comment on `ECOM-12`, logs an hour against it, and — because of
step 2 — shows up in that issue's **Development** panel linked to the
exact commit.

## 4. Seed the initial backlog

Create one Epic ("Prod-realism sprint") and a Story under it for each
piece of this sprint:

- Split the monorepo into per-service repos
- AWS Secrets Manager + External Secrets Operator
- Stripe checkout integration
- Real CI test gate
- Jira integration (this doc)

Reference the matching issue key in each repo's PRs and commits going
forward (see each repo's own `.github/PULL_REQUEST_TEMPLATE.md`).

## 5. Automatic failure tickets

Every service's `Jenkinsfile` (`ecom-backend`, `ecom-frontend`,
`ecom-k8s`) files a Jira Bug automatically in its `post { failure { ... } }`
block when a build fails — a real "someone has to triage this ticket"
loop, not just commit-linking. It needs two Jenkins credentials that
aren't app secrets, so they're kept in Jenkins' own credential store
rather than AWS Secrets Manager (see each Jenkinsfile's header comment):

- `jira-api-token` — Username with password: username = the Jira account
  email, password = a Jira API token (create one at
  `id.atlassian.com/manage-profile/security/api-tokens`)
- `jira-site-url` — Secret text: `https://<your-site>.atlassian.net`
  (not sensitive, but kept as a credential rather than hardcoded in
  committed Jenkinsfiles — same reasoning as `ecr-registry-url`)
