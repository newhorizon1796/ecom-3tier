# 3-Tier E-Commerce Platform — Full DevOps Reference Implementation

A minimal but fully wired e-commerce app demonstrating a production-style DevOps toolchain:

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
├── k8s/                  Kubernetes manifests (Deployments, Services, Ingress, HPA, Mongo StatefulSet)
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
5. **Monitoring** — install `kube-prometheus-stack` via Helm using `monitoring/kube-prometheus-stack-values.yaml`; the backend exposes Prometheus metrics at `/metrics`, scraped via the `ServiceMonitor` in `monitoring/backend-servicemonitor.yaml`; import `monitoring/grafana-dashboard-ecom.json` into Grafana.

See the `README.md`-style comments/instructions inside each subfolder's files for exact commands.

## Prerequisites / dependencies (all versions pinned where possible)

- Node.js 20.x, npm 10.x
- Docker 24+ / Docker Compose v2
- Trivy 0.55+ (`aquasecurity/trivy`)
- Terraform 1.9+, AWS provider ~> 5.0
- kubectl 1.29+, AWS CLI v2 (`aws eks update-kubeconfig`)
- Helm 3.x (for kube-prometheus-stack)
- A Jenkins controller with: Docker, Git, Pipeline, Credentials Binding, and Kubernetes CLI plugins; an agent with Docker, Trivy, kubectl, terraform, and aws-cli installed (see `Jenkinsfile` comments)
