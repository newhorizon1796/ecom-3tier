# ShopEasy — 3-Tier E-Commerce Platform (polyrepo, full DevOps toolchain)

This is the **hub repo**: architecture docs, local-dev `docker-compose.yml`,
and the build history. The actual app, infra, and platform config each live
in their own repo, mirroring how a real org splits a system across
service-owned repos instead of one monorepo.

> **New here?** [`docs/HANDBOOK.md`](docs/HANDBOOK.md) is a step-by-step
> build log of standing the original single-cluster stack up from scratch —
> every phase's *why* and *how*, every real error hit and how it was fixed.
> [`docs/COST-OPTIMIZATION.md`](docs/COST-OPTIMIZATION.md) covers this
> project's actual cost drivers. [`docs/PAYMENT-GATEWAY.md`](docs/PAYMENT-GATEWAY.md)
> is the Stripe integration design (now implemented — see below).
> [`docs/JIRA-INTEGRATION.md`](docs/JIRA-INTEGRATION.md) covers how work is
> tracked.

## The repos

| Repo | What it owns |
|---|---|
| [`ecom-frontend`](https://github.com/newhorizon1796/ecom-frontend) | React SPA — product catalog, cart, Stripe checkout redirect |
| [`ecom-backend`](https://github.com/newhorizon1796/ecom-backend) | Express API — products, orders, Stripe checkout + webhook, `/health`, `/metrics` |
| [`ecom-infra`](https://github.com/newhorizon1796/ecom-infra) | Terraform — VPC, EKS, ECR, AWS Secrets Manager + IRSA |
| [`ecom-k8s`](https://github.com/newhorizon1796/ecom-k8s) | Kubernetes manifests + the deploy Jenkins pipeline |
| [`ecom-monitoring`](https://github.com/newhorizon1796/ecom-monitoring) | kube-prometheus-stack values, ServiceMonitor, Grafana dashboard |
| `ecom-3tier` (this repo) | Docs, local-dev compose, cross-repo build history |

Each app/infra repo has its own `Jenkinsfile`, its own GitHub webhook, and
its own `README.md` with repo-specific commands. `ecom-backend` and
`ecom-frontend` build/test/scan/push their own image and then trigger
`ecom-k8s`'s deploy pipeline as a downstream job — they never run `kubectl`
directly. See [`ecom-k8s`'s README](https://github.com/newhorizon1796/ecom-k8s#readme)
for the full deploy order.

```
GitHub (5 repos, 5 webhooks) → Jenkins (per-repo build+test+scan+push,
                                         ecom-k8s owns kubectl apply)
                                              │
ecom-infra (Terraform: VPC+EKS+ECR+Secrets Manager) ──────┘
                                              │
                                              ▼
                                  Kubernetes (EKS)
                             ┌───────────┬───────────┐
                             │ frontend  │  backend  │──── Stripe (Checkout + webhook)
                             │ (React/   │ (Node/    │
                             │  Nginx)   │  Express) │
                             └───────────┴───────────┘
                                   │           │
                                   ▼           ▼
                                Ingress   MongoDB (StatefulSet)
                                   │           │
                                   │      External Secrets Operator
                                   │      ← AWS Secrets Manager (mongo, stripe creds)
                                   ▼
                        Prometheus + Grafana (kube-prometheus-stack)

Jira (ECOM project) ← GitHub for Jira app (all 5 repos) + Smart Commits
                     ← auto-filed Bug on any Jenkins pipeline failure
```

## Quick start (local, no cluster needed)

Clone all repos as siblings, then run compose from this one:

```bash
mkdir shopeasy && cd shopeasy
git clone https://github.com/newhorizon1796/ecom-3tier.git
git clone https://github.com/newhorizon1796/ecom-backend.git
git clone https://github.com/newhorizon1796/ecom-frontend.git
cd ecom-3tier
docker compose up --build
# frontend -> http://localhost:3000
# backend  -> http://localhost:5000/api/products
# metrics  -> http://localhost:5000/metrics
```

Checkout works locally too if you drop real Stripe test keys into a `.env`
file next to `docker-compose.yml` — see the comment at the top of that file.

## Path to production

This now spans five repos instead of one folder tree. At a high level:

1. **`ecom-infra`** — `terraform apply` provisions the VPC, EKS cluster, two ECR repos, and the `mongo-credentials`/`stripe-credentials` AWS Secrets Manager secrets + the IRSA role External Secrets Operator needs.
2. **Cluster add-ons (manual, one-time)** — `ingress-nginx`, `kube-prometheus-stack`, and **External Secrets Operator** via Helm (the last one is new — see `ecom-k8s`'s README).
3. **`ecom-k8s`** — run its Jenkins job once with `SERVICE=bootstrap` to apply everything that isn't image-templated (namespace, storageclass, ExternalSecrets, Mongo, services, HPA, ingress).
4. **`ecom-backend` / `ecom-frontend`** — each has its own Jenkins job (triggered by its own GitHub webhook) that tests, builds, Trivy-scans, pushes to ECR, then triggers `ecom-k8s`'s deploy job for just that service.
5. **Jira** — see `docs/JIRA-INTEGRATION.md` for the GitHub for Jira app, Smart Commits, and the automatic failure-ticket wiring in each Jenkinsfile.

Full exact commands for every step are in the manual runbook (delivered
alongside this repo's setup, not committed as a single doc — each repo's
own README has the commands specific to it).

## Prerequisites / dependencies

- Node.js 20.x, npm 10.x
- Docker 24+ / Docker Compose v2
- Trivy 0.55+ (`aquasecurity/trivy`)
- Terraform 1.9+, AWS provider ~> 5.0
- kubectl 1.29+, AWS CLI v2 (`aws eks update-kubeconfig`)
- Helm 3.x (ingress-nginx, kube-prometheus-stack, **external-secrets**)
- A Jenkins controller with one job per repo (5 jobs total): Docker, Git, Pipeline, Credentials Binding plugins; an agent with Docker, Trivy, kubectl, terraform, aws-cli, curl (for the Jira API call) installed
- A Jira Cloud site with the **GitHub for Jira** app installed
