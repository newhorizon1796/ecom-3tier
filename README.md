# 3-Tier E-Commerce Platform — Full DevOps Reference Implementation

A minimal but fully wired e-commerce app demonstrating a production-style DevOps toolchain:

> **New to this repo?** [`docs/HANDBOOK.md`](docs/HANDBOOK.md) is a step-by-step build
> log of standing this whole stack up from scratch on a fresh AWS account — every
> phase's *why* and *how*, plus every real error hit along the way with how it was
> diagnosed and fixed. Read it if you're trying to reproduce this manually or want the
> reasoning this README alone doesn't have room for.

```
GitHub  →  Jenkins CI/CD  →  Docker build  →  Trivy image scan  →  Push to ECR
                                                                        │
Terraform (VPC + EKS + ECR)  ──────────────────────────────────────────┘
                                                                        │
                                                                        ▼
                                                       Kubernetes (EKS)
                                                  ┌───────────┬───────────┐
                                                  │ frontend  │  backend  │
                                                  │ (React/   │ (Node/    │
                                                  │  Nginx)   │  Express) │
                                                  └───────────┴───────────┘
                                                        │           │
                                                        ▼           ▼
                                                     Ingress     MongoDB
                                                                (StatefulSet)
                                                                        │
                                                        Prometheus + Grafana
                                                        (kube-prometheus-stack,
                                                         scrapes /metrics)
```

## Architecture (3 tiers)

| Tier | Technology | Path |
|---|---|---|
| Presentation | React 18, served by Nginx | `frontend/` |
| Application  | Node.js 20 + Express REST API | `backend/` |
| Data         | MongoDB 7 | `database/`, `k8s/mongo-*.yaml` |

## Repo layout

```
ecom-3tier/
├── frontend/            React SPA (product catalog + cart) + Dockerfile + nginx.conf
├── backend/              Express API (products, orders, /health, /metrics) + Dockerfile
├── database/init/       MongoDB seed script
├── docker-compose.yml    Local dev: all 3 tiers with one command
├── Jenkinsfile           Full CI/CD pipeline (test → build → Trivy scan → push → deploy)
├── trivy/                Trivy config + ignore file
├── terraform/            AWS VPC + EKS + ECR (IaC for the cluster the app runs on)
├── k8s/                  Kubernetes manifests (Deployments, Services, Ingress, HPA, Mongo StatefulSet + seed Job, StorageClass)
└── monitoring/           kube-prometheus-stack Helm values, ServiceMonitor, Grafana dashboard
```

## Quick start (local, no cluster needed)

```bash
git clone <your-repo-url> ecom-3tier && cd ecom-3tier
docker compose up --build
# frontend -> http://localhost:3000
# backend  -> http://localhost:5000/api/products
# metrics  -> http://localhost:5000/metrics
```

## Path to production

1. **GitHub** — push this repo, protect `main`, Jenkins polls/webhooks it.
2. **Terraform** — `cd terraform && terraform init && terraform apply` provisions VPC, EKS cluster, and two ECR repos (frontend/backend).
3. **Jenkins** — configure a Multibranch/Pipeline job pointing at the repo; it will:
   - install deps + run unit tests (frontend & backend, in parallel)
   - build Docker images for both tiers
   - scan both images with **Trivy** (pipeline fails on HIGH/CRITICAL CVEs)
   - push images to ECR
   - `kubectl apply` the manifests in `k8s/` (image tag templated from the Jenkins build)
4. **Kubernetes (EKS)** — Deployments for frontend/backend, StatefulSet+PVC for MongoDB, an Ingress (ALB or nginx), an HPA on the backend.
5. **Ingress controller (manual, one-time per cluster)** — the `nginx` Ingress in `k8s/ingress.yaml` needs an actual controller running to do anything; nothing in this repo installs one. Install `ingress-nginx` via Helm — this is what provisions the AWS Load Balancer and gives the app a real public URL:
   ```bash
   helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
   helm repo update
   helm install ingress-nginx ingress-nginx/ingress-nginx \
     --namespace ingress-nginx --create-namespace \
     --set controller.service.type=LoadBalancer
   kubectl get svc -n ingress-nginx ingress-nginx-controller
   # EXTERNAL-IP column shows the load balancer's public hostname once provisioned (a few minutes)
   ```
   `k8s/ingress.yaml` has no `host:` filter, so it routes on whatever hostname reaches the load balancer — the AWS-assigned one works immediately, no domain required. Point a real domain at it later via a CNAME if you want one.
6. **Monitoring (manual, one-time per cluster)** — same story as ingress: nothing in this repo installs `kube-prometheus-stack` itself, only the config it needs once it exists.
   ```bash
   helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
   helm repo update
   helm install monitoring prometheus-community/kube-prometheus-stack \
     --namespace monitoring --create-namespace \
     -f monitoring/kube-prometheus-stack-values.yaml
   kubectl apply -f monitoring/backend-servicemonitor.yaml
   ```
   The backend exposes Prometheus metrics at `/metrics`, scraped via that `ServiceMonitor`; import `monitoring/grafana-dashboard-ecom.json` into Grafana (Dashboards → New → Import → Upload JSON, or via the API — see `monitoring/README.md`) for request rate / error rate / p95 latency panels. Full details, including how to reach Grafana, are in `monitoring/README.md`.

See the `README.md`-style comments/instructions inside each subfolder's files for exact commands.

## Prerequisites / dependencies (all versions pinned where possible)

- Node.js 20.x, npm 10.x
- Docker 24+ / Docker Compose v2
- Trivy 0.55+ (`aquasecurity/trivy`)
- Terraform 1.9+, AWS provider ~> 5.0
- kubectl 1.29+, AWS CLI v2 (`aws eks update-kubeconfig`)
- Helm 3.x (for ingress-nginx and kube-prometheus-stack — see "Path to production" below)
- A Jenkins controller with: Docker, Git, Pipeline, Credentials Binding, and Kubernetes CLI plugins; an agent with Docker, Trivy, kubectl, terraform, and aws-cli installed (see `Jenkinsfile` comments)
