# Build Handbook: 3-Tier E-Commerce DevOps Pipeline

A step-by-step record of taking `ecom-3tier` from a scaffolded-but-never-run repo to a
live application on EKS with a working Jenkins CI/CD pipeline, a public URL, and
Prometheus/Grafana monitoring — written so someone can **manually reproduce this on a
fresh AWS account**, and so every real error hit along the way is preserved as a
troubleshooting lesson rather than smoothed over.

**How to use this doc:** each phase has a *Goal*, *Why*, numbered *Steps* with the
actual commands run, and an **Errors & Troubleshooting** subsection for anything that
went wrong at that exact point — symptom, how it was diagnosed, root cause, fix, and
the takeaway. Section 12 has a per-tool checklist you can use on a new project without
reading the whole narrative.

---

## 0. Starting point

The repo already existed, fully scaffolded in a single "Initial commit" — React
frontend, Express backend, MongoDB, a `Jenkinsfile`, Terraform for AWS/EKS, Kubernetes
manifests, and a monitoring folder — but **none of it had ever actually been run**. That
distinction matters: scaffolding that compiles is not the same as scaffolding that
works, and this project's whole arc was discovering the gap between the two.

Order of attack, and why: **local validation → CI pipeline review → infrastructure →
CI server → wire CI to infra → public access → observability**. Each stage only makes
sense once the one before it is trustworthy — there's no point debugging a Kubernetes
deploy step if you haven't confirmed the Docker images even build.

---

## 1. Local validation (Docker Compose)

**Goal:** prove the three-tier app actually runs before trusting any of the automation
built around it.

**Why first:** automation (CI, IaC) multiplies whatever's underneath it — bugs included.
Validating the app manually first means later failures can be attributed to the
*infrastructure*, not the app itself.

### Steps

1. Install Docker Desktop (`winget install --id Docker.DockerDesktop`) — needs WSL2,
   which was already enabled on this machine.
2. Run the backend's own test suite in isolation: `cd backend && npm ci && npm test`.
3. Build the frontend to catch compile-time errors early: `cd frontend && npm ci && npm run build`.
4. Bring up the full stack: `docker compose up --build` from the repo root.
5. Verify all three tiers actually talk to each other, not just that each starts:
   `curl http://localhost:3000/api/products` (frontend's nginx → backend → Mongo, not
   just `curl`-ing the backend directly — that only proves the backend, not the wiring).

### Errors & Troubleshooting

**Symptom:** `docker build` fails on both `backend` and `frontend` images with
`npm error The 'npm ci' command can only install with an existing package-lock.json`.

- **Diagnosis:** `git status` after running `npm install` locally showed
  `package-lock.json` as *untracked* in both `backend/` and `frontend/` — meaning the
  original scaffold commit never included them, even though both Dockerfiles use
  `npm ci` (which requires a lockfile; unlike `npm install`, it refuses to generate one).
- **Root cause:** lockfiles were simply never committed.
- **Fix:** ran `npm install` in both directories to generate the lockfiles, committed them.
- **Takeaway:** `npm ci` failing with that exact message always means "no lockfile
  reachable" — check whether it's `.gitignore`d, `.dockerignore`d, or genuinely never
  generated, in that order.

**Symptom:** `docker login`-adjacent and Windows path issues when scripting around
Docker/Node from Git Bash.

- **Root cause:** Node.js (a native Windows binary here) doesn't understand Git Bash's
  `/tmp` path translation — `/tmp/foo.json` gets misinterpreted as `C:\tmp\foo.json`,
  which doesn't exist.
- **Fix:** write scratch files to a path under the current working directory instead of
  `/tmp` when a Windows-native tool (not a POSIX one) will read them.
- **Takeaway:** on Windows-via-Git-Bash, only *POSIX* tools (bash itself, curl, ssh,
  grep) reliably understand `/tmp`-style paths — anything that's a native Windows
  executable (`node.exe`, `python.exe`) needs a real Windows-resolvable path.

---

## 2. Jenkins pipeline code review (static)

**Goal:** find bugs in the `Jenkinsfile` by reading it carefully *before* a real Jenkins
server exists to run it against — cheaper to fix on paper than after N failed builds.

**Why this order:** every bug found here was a genuine logic error that would have
caused a real pipeline failure later; catching them via review instead of trial-and-error
saved several of the build iterations documented in Section 5.

### Findings & fixes

| # | Bug | Why it's wrong | Fix |
|---|---|---|---|
| 1 | `k8s/*-deployment.yaml` committed a literal placeholder `image:` value; Jenkins deployed with `kubectl set image` *after* `kubectl apply` | `kubectl apply` is declarative — it resets the Deployment to whatever the file says on **every single run**, undoing the previous `set image` before immediately re-applying it. Every deploy did two rollouts instead of one, and briefly rolled out an invalid image. | Replace the literal image with a `__BACKEND_IMAGE__` / `__FRONTEND_IMAGE__` token, `sed`-substitute it into the real tag immediately before `kubectl apply`, drop the separate `kubectl set image` step entirely. |
| 2 | `k8s/secret.yaml` (`mongo-credentials`) was applied by Jenkins but never referenced by the Mongo `StatefulSet` or the backend `Deployment` | Mongo ran fully unauthenticated in "production" despite a Secret existing that implied otherwise — false sense of security. | Wire the Secret into Mongo's `env` (`MONGO_INITDB_ROOT_USERNAME/PASSWORD`) and into the backend via a credentialed `MONGO_URI` key on the same Secret. |
| 3 | `IMAGE_TAG` computed from `env.GIT_COMMIT` inside the top-level `environment {}` block | That block evaluates **before** the `Checkout` stage runs `checkout scm` — on many Jenkins job types `GIT_COMMIT` isn't populated yet at that point, so the tag can silently fall back to the build number instead of the commit SHA. | Move the computation into a `script {}` block inside the `Checkout` stage, using `git rev-parse --short HEAD` directly instead of relying on the env var's timing. |

### Errors & Troubleshooting

No runtime errors here — this section is purely static review. The value was in
**not** needing runtime errors to find these; all three were confirmed later (Section 5)
to be exactly the bugs the review predicted.

---

## 3. Terraform: provisioning AWS infrastructure

**Goal:** stand up the VPC, EKS cluster, and two ECR repositories that everything else
depends on.

**Why Terraform before Jenkins:** the CI pipeline's later stages (`docker push`,
`kubectl apply`) need real ECR repos and a real cluster to target — there's nothing to
wire Jenkins credentials to until this exists.

### Steps

1. `terraform init` / `terraform validate` — safe, no AWS calls that cost anything, catches
   syntax and module-resolution errors early.
2. Decide the target region: the AWS CLI's configured default (`ap-south-1`) differed
   from the repo's hardcoded default (`us-east-1`, baked into `vpc_cidr`, `azs`,
   `cluster_name` etc.). **Always check this explicitly** — Terraform uses the region set
   in the `provider "aws"` block via `var.aws_region`, not your CLI's default, so a
   mismatch doesn't error, it just silently deploys somewhere you didn't expect.
   Created a local, `.gitignore`d `terraform.tfvars` overriding `aws_region` and `azs`
   to match — account-specific values don't belong in the committed defaults.
3. `terraform plan -out=tfplan` then `terraform apply "tfplan"`.

### Errors & Troubleshooting

**Symptom:** `terraform apply` fails partway through with three separate
`AccessDeniedException` errors — `ecr:CreateRepository`, `kms:TagResource`,
`logs:CreateLogGroup` — after 41 other resources (VPC, subnets, IAM roles, security
groups, NAT gateway) already succeeded.

- **Diagnosis:** read the attached IAM policies for the executing user
  (`aws iam list-attached-user-policies`) — a long list of `*FullAccess` managed
  policies (EC2, VPC, S3, Route53, SQS, EventBridge, FSx), but nothing covering ECR,
  KMS, or CloudWatch Logs specifically.
- **Root cause:** the AWS account's IAM user had a curated, incomplete permission set —
  consistent with a restricted training/lab account, not a general-purpose one.
- **First fix attempt:** attach the three missing specific policies
  (`AmazonEC2ContainerRegistryFullAccess`, `CloudWatchLogsFullAccess`,
  `AWSKeyManagementServicePowerUser`) — **failed** with
  `LimitExceeded: Cannot exceed quota for PoliciesPerUser: 10`. The account was already
  at AWS's hard cap of 10 attached managed policies per IAM user.
- **Real fix:** the account owner manually attached `AdministratorAccess` via the
  console (a single policy, fits within the quota, supersedes the granular approach).
- **Takeaway:** `LimitExceeded` on `AttachUserPolicy` is a hard AWS-wide quota (10 managed
  policies per user by default), not a permissions issue — the fix is to consolidate
  (fewer, broader policies) or use inline policies (a separate quota bucket), not to
  request more attachments of the same kind.

**Symptom:** re-running `terraform apply` after the IAM fix, the previously-stuck EKS
node group is now showing `CREATE_FAILED` with health issue
`AsgInstanceLaunchFailures: ... InvalidParameterCombination — The specified instance
type is not eligible for Free Tier`.

- **Diagnosis:** `aws autoscaling describe-scaling-activities` on the underlying ASG
  showed every launch attempt failing with that exact message, retried every ~4 minutes
  since node-group creation started — silently, since `terraform apply`'s progress
  output just showed "Still creating..." with no indication *why*.
- **Root cause:** `node_instance_types = ["t3.medium"]` wasn't on this account's
  allow-list of launchable instance types (confirmed via
  `aws ec2 describe-instance-types --filters Name=free-tier-eligible,Values=true`,
  which returned a custom list including `t3.micro`, `t3.small`, `t4g.small`,
  `c7i-flex.large`, `m7i-flex.large` — broader than genuine AWS Free Tier, again
  pointing at an account-level restriction rather than a real technical limit).
- **Fix:** changed `node_instance_types` to `m7i-flex.large` (2 vCPU / 8 GiB) — **only**
  in the local, `.gitignore`d `terraform.tfvars`, deliberately leaving the committed
  repo default (`t3.medium`) untouched, since this restriction is specific to one
  account's plan, not a general AWS/EKS constraint anyone else would hit.
- **Takeaway:** when a fix is a workaround for an *environment-specific* restriction
  (not a bug in the general approach), don't bake it into shared defaults — keep it in
  the local override so the repo stays correct advice for everyone else.

**Symptom:** even after fixing the instance type, the node group still won't create —
`InvalidParameterException: Requested AMI for this version 1.30 is not supported`.

- **Diagnosis:** `aws eks describe-cluster-versions --cluster-versions 1.30` returned
  `"status": "UNSUPPORTED"`, with `endOfExtendedSupportDate` already ~6 weeks in the
  past. `cluster_version = "1.30"` was simply the stale default baked into
  `terraform/variables.tf` from whenever the repo was originally scaffolded — nobody had
  checked whether it was still current.
- **Fix:** bumped to `1.34` (current `STANDARD_SUPPORT`, no extended-support surcharge)
  — this time in the **committed** default too, since an unsupported K8s version is a
  universal problem, not an account-specific one.
- **Second-order problem:** EKS only allows upgrading **one minor version at a time** —
  jumping straight from 1.30 to 1.34 fails with
  `InvalidParameterException: Unsupported Kubernetes minor version update from 1.30 to 1.34`.
  Had to step through `1.31 → 1.32 → 1.33 → 1.34` sequentially, each hop its own
  `terraform apply` (control-plane modify ~7 min + node-group rolling update ~9 min
  each, ~17 min per hop, ~70 min total).
- **Takeaway:** always check a base/cluster version's support status *before* using it as
  a default, especially in a scaffold that might be months old by the time it's actually
  run. For EKS specifically, budget for sequential single-hop upgrades, not a direct jump.

**Symptom:** after the sequential upgrade finished, `list-nodegroups` shows **two** node
groups — one healthy, one still `CREATE_FAILED`.

- **Root cause:** the original broken node group (from the Free-Tier-instance-type
  failure above) got replaced in Terraform *state* by a new one once `node_instance_types`
  changed (AWS doesn't allow in-place instance-type changes on a node group, so Terraform
  destroys-and-recreates) — but the actual AWS-side object from the failed attempt was
  never cleaned up, since Terraform's state had already moved on to tracking the
  replacement.
- **Fix:** `aws eks delete-nodegroup` directly against the orphaned one — safe, since it
  never had any running instances and wasn't in Terraform state anymore.
- **Takeaway:** after any resource replacement caused by an earlier failed attempt,
  check for orphans with the provider's own list command (not just `terraform state
  list`) — Terraform only tracks what's *currently* in state, not everything it ever
  touched.

---

## 4. Setting up the Jenkins server

**Goal:** get an actual running Jenkins controller, sized appropriately, reachable, and
reasonably secured.

### Steps

1. Locate the target machine — an EC2 instance the account already had, stopped
   (`aws ec2 describe-instances`).
2. Decide sizing: the existing instance was `c7i-flex.large` (2 vCPU / 4 GiB) — tight for
   Jenkins + Docker builds + Trivy scans running concurrently. Attempted a resize to
   `t3.large` (8 GiB) via `aws ec2 modify-instance-attribute` —
   **blocked** (`FreeTierRestrictionError`, this account's plan disallows instance-type
   changes via that API, separate from the earlier IAM issue). Fell back to keeping the
   existing size and adding a 4 GiB swap file instead.
3. `aws ec2 start-instances`, then SSH in.
4. **Assumed Amazon Linux (`ec2-user`) — wrong.** `Permission denied (publickey)` on
   first SSH attempt; checking the AMI (`aws ec2 describe-images`) showed it was
   **Ubuntu**, whose default user is `ubuntu`. Reconnected with the correct username.
5. **Discovered Jenkins was already installed and running**, along with Docker, Java 21,
   kubectl, Terraform, AWS CLI, and git — apparently set up in an earlier, unrecorded
   session. Only Trivy was missing; installed it via the official apt repo.
6. Verified all Jenkinsfile-required plugins (Pipeline, Git, Docker, Credentials
   Binding, AWS Credentials) were already present by listing
   `/var/lib/jenkins/plugins/`.
7. Locked down the security group: found a pre-existing rule allowing **all protocols,
   all ports, from `0.0.0.0/0`** (plus redundant unused 80/443 rules), confirmed via
   `sudo ss -tlnp` that only 22 and 8080 were actually listening, then
   `aws ec2 revoke-security-group-ingress`'d everything else.

### Errors & Troubleshooting

**Symptom:** first `docker build` triggered from within a Jenkins pipeline step would
have failed with a Docker socket permission error (caught proactively before the first
real build, not from a build failure).

- **Diagnosis:** `id jenkins` showed the `jenkins` system user's only group was `jenkins`
  — not `docker` — while `/var/run/docker.sock` is owned `root:docker` with `660`
  permissions.
- **Fix:** `sudo usermod -aG docker jenkins && sudo systemctl restart jenkins` (group
  membership changes require reprocessing the user's session, hence the restart).
- **Takeaway:** on any fresh Jenkins-on-a-VM setup where Jenkins runs shell steps
  invoking `docker`, check the service account's group membership *before* the first
  build, not after it fails.

---

## 5. Wiring Jenkins to the pipeline (the iterative debugging loop)

**Goal:** get `Build #1` through the full `Jenkinsfile` — Checkout → Install & Test →
Build Images → Trivy Scan → Push to ECR → Deploy to Kubernetes — cleanly, end to end.

**Why this took 15 build iterations:** this is the stage where every earlier
assumption gets tested against reality simultaneously — credentials, tooling, network,
image content, and Kubernetes state all have to be correct *together*. Each build
exposed exactly one new problem; fixing it revealed the next. That's normal, not a sign
of a bad plan — the alternative (trying to fix everything blind, in one shot) is far
slower to debug because failures compound instead of isolating cleanly.

### The credential-wiring problem, first

Before any build could get past the earliest stages, three Jenkins credentials had to
exist with **exact-match IDs** (`Jenkinsfile` does `credentials('ecr-registry-url')` and
`credentialsId: 'aws-creds'` / `'kubeconfig'` — these are literal string lookups, not
approximate).

**Symptom:** builds failed immediately with `ERROR: ecr-registry-url`, before any real
stage ran.

- **Diagnosis:** inspected `/var/lib/jenkins/credentials.xml` for the stored credential
  **IDs only** (never their encrypted secret values) via
  `grep '<id>' credentials.xml`. Found the actual registry URL *value* had been typed
  into the **ID** field by mistake, and the AWS credential had been named `awscred`
  instead of `aws-creds` — both simple typos, but Jenkins does exact string matching,
  so "close" doesn't work.
- **Fix:** deleted both wrong entries and recreated all three correctly — done via
  Jenkins' own Credentials REST API (`POST .../createCredentials` with a credential XML
  body) over an SSH session, using a user-generated **API token** rather than a
  password, so the login credential itself never had to be shared.
  - `ecr-registry-url` — Secret text, the actual ECR registry hostname.
  - `kubeconfig` — Secret file, generated locally via
    `aws eks update-kubeconfig --kubeconfig jenkins-kubeconfig.yaml`, uploaded as
    base64 in the credential-creation XML.
  - `aws-creds` — Username/password, using a **freshly created, dedicated** IAM access
    key (rather than reusing the one already in local use) so Jenkins has its own
    revocable credential.
- **Side-quest bug:** `curl`'s own URL-globbing feature (enabled by default) misparses
  `[...]` characters in query strings like `?tree=jobs[name,url]` as a glob pattern,
  failing with a cryptic `curl: (3) URL using bad/illegal format` — fixed by adding
  `--globoff` to every Jenkins REST API call.
- **Takeaway:** when scripting the Jenkins REST API with `curl`, always pass
  `--globoff` if any query parameter contains `[` or `{` — otherwise the failure looks
  like a Jenkins problem when it's actually curl's own URL parser.

### Build-by-build log

| Build | Symptom | Root cause | Fix |
|---|---|---|---|
| 2, 4 | `Invalid option type "ansiColor"` — Groovy compile error, pipeline never starts | The `AnsiColor` Jenkins plugin (for colorized console output) isn't installed | Removed `ansiColor('xterm')` from `options {}` — purely cosmetic, not worth installing a plugin for |
| 6, 7 | `ERROR: ecr-registry-url` at credential-binding time | Wrong credential IDs (see above) | Recreated all 3 credentials correctly via the REST API |
| 8 | `script returned exit code 127` in Install & Test | **Node.js/npm not installed on the Jenkins agent at all** — never checked when the box was first prepared | `sudo apt-get install -y nodejs npm` (see below for a side-quest this triggered) |
| 8 (cont.) | Trivy gate fails: 1 **CRITICAL** (`CVE-2026-59873`, node-tar gzip-bomb DoS) + 19 HIGH | Traced via `grep` that neither `tar` nor `sigstore` appear anywhere in `backend/package-lock.json` — the vulnerable code was npm's **own bundled internal dependencies**, vendored inside `node:20-alpine`'s global npm install, unrelated to the app | Stripped `npm`/`npx` from the final backend image entirely — the container only ever runs `node src/server.js`, never `npm`, so it doesn't need to exist at runtime |
| 9 | Trivy gate fails again: 4 HIGH, `libcrypto3`/`libssl3` (OpenSSL), `Status: fixed` | The cached `node:20-alpine` base image layer had OS packages older than the fixes already available in Alpine's repo | Added `RUN apk update && apk upgrade --no-cache` to both Dockerfiles (backend, and the frontend's nginx runtime stage) to always pick up current OS patches at build time |
| 10 | `docker login`: `400 Bad Request` | Console trace showed `aws ecr get-login-password --region us-east-1` — `AWS_REGION` in the Jenkinsfile was still `us-east-1`; an earlier local edit to `ap-south-1` had never actually been `git push`ed | Committed and pushed the real fix; used the moment to also add `.gitignore` entries for local scratch files (kubeconfig, tfplan) that had been sitting untracked |
| 11 | ECR push **succeeded** for the first time; Deploy stage: `kubectl apply` fails, `Unable to locate credentials` | The generated kubeconfig authenticates via AWS's exec-credential plugin (shells out to `aws eks get-token`), which needs real AWS credentials in its environment — but the Deploy stage's `withCredentials` only bound `kubeconfig`, not `aws-creds` | Added `aws-creds` binding alongside `kubeconfig` in that stage (same pattern already used elsewhere in the file) |
| 12 | All manifests applied! But `kubectl rollout status deployment/backend` times out; pods show `mongo-0` stuck `Pending`, backend `CrashLoopBackOff` | EKS's default `gp2` StorageClass uses the **in-tree** `kubernetes.io/aws-ebs` provisioner, which was **removed from Kubernetes itself** in the CSI migration — it can never bind a PVC. Backend's own code (`connectDB(...).catch(() => process.exit(1))`) means it can never start without Mongo, hence the crash loop is a downstream symptom, not the real bug | Added the `aws-ebs-csi-driver` EKS addon + an IRSA role in Terraform; added `k8s/storageclass.yaml` (a real `gp3` class using `ebs.csi.aws.com`); referenced it explicitly on the StatefulSet's `volumeClaimTemplate`; applied it before `mongo-statefulset.yaml` in the deploy sequence |
| 13 | `The StatefulSet "mongo" is invalid: ... Forbidden: updates to statefulset spec for fields other than 'replicas'... are forbidden` | `volumeClaimTemplates` is **immutable** on an existing StatefulSet — the one created in build #12 predates the `storageClassName` field being added | Manually deleted the StatefulSet object (its PVC survives independently and was already correctly bound) so the next apply recreates it cleanly |
| 14 | `error from registry: The image tag 'af8048e' already exists ... cannot be overwritten because the tag is immutable` | Re-triggered a build against the **same commit** as a prior successful push — the immutable-tag policy (a deliberate design choice, see Section 6) correctly refused to overwrite it | Needed a genuinely new commit; used the opportunity to also fix a real gap noticed along the way (see next row) |
| 14 (cont.) | `/api/products` returns `[]` on the live cluster | Docker Compose seeds Mongo via the official image's `docker-entrypoint-initdb.d/` convention, which **only fires on a truly empty volume** — a StatefulSet's PVC is typically already initialized by the time this is ever applied, so it never fires there | Added `k8s/mongo-seed-job.yaml` — an idempotent `Job` that only inserts if the catalog is empty, safe to re-apply on every deploy — wired into the Jenkinsfile after `mongo-service.yaml` |
| — | (manual test of the new seed job) `MongoServerError: Command aggregate requires authentication` | The job's first draft connected with a bare, unauthenticated URI, but Mongo has root auth enabled (see Section 2, finding #2) | Pulled `MONGO_URI` from the same `mongo-credentials` Secret the backend uses, via Kubernetes' `$(VAR)` substitution syntax directly in the container's `command` array |
| 15 | — | — | **Full pipeline green, end to end** |

### A meta-lesson from this whole section

Several of these bugs (region, credential IDs, Node.js missing) were things a first-time
setup checklist would have caught in five minutes. They took multiple build cycles here
specifically *because* the environment (a pre-existing, partially-configured Jenkins box)
skipped the normal "set this up from scratch, checking each prerequisite" path. The
per-tool checklist in Section 12 exists to make that path explicit for next time.

---

## 6. Design decision: immutable ECR tags, and what that costs you operationally

Both ECR repos are `image_tag_mutability = "IMMUTABLE"` (Section 3) — deliberate,
because it protects every commit-SHA-tagged image from being silently overwritten or
tampered with after the fact. The Jenkinsfile originally *also* pushed a floating
`:latest` tag on every build, which is fundamentally incompatible with immutability
(the whole point of `:latest` is that it gets overwritten). That surfaced as a real
build failure once Terraform actually created the repos (Section 5, implicit in the
"immutable tag" build failure above traces back to this).

**Resolution:** dropped the `:latest` push entirely. Deploys already reference the
commit-SHA tag; a floating tag wasn't adding anything except the conflict. This also
means: **re-running a Jenkins build against a commit that already built successfully
will always fail at the push step** (Section 5, build #14) — that's not a bug, it's the
immutability policy working. If you need to re-run a deploy without a code change, use
`kubectl apply`/`rollout restart` directly against the already-pushed image tag instead
of re-triggering the whole pipeline.

---

## 7. Public ingress

**Goal:** a real, permanent public URL for the application — not a temporary
`kubectl port-forward`.

**Why after CI/CD, not before:** an Ingress is meaningless without a controller to
implement it, and installing one is worth doing once the app it's routing to is
actually stable, not while it's still being debugged.

### Steps

1. Install the `ingress-nginx` controller via Helm, with its Service set to
   `LoadBalancer` — this is what tells the underlying cloud provider (via Kubernetes'
   in-tree/cloud-controller integration) to actually provision a real AWS ELB:
   ```bash
   helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
   helm install ingress-nginx ingress-nginx/ingress-nginx \
     --namespace ingress-nginx --create-namespace \
     --set controller.service.type=LoadBalancer
   ```
2. `kubectl get svc -n ingress-nginx ingress-nginx-controller` — the `EXTERNAL-IP`
   column fills in with the load balancer's public hostname once AWS finishes
   provisioning it (a few minutes).

### Errors & Troubleshooting

**Symptom:** the app is unreachable at the new public hostname.

- **Diagnosis:** `curl` the hostname directly — nothing matched. The existing
  `k8s/ingress.yaml` had `host: shop.example.com` — a placeholder domain from the
  original scaffold that nobody owns, so the ingress controller correctly refused to
  route requests whose `Host` header didn't match it (and the real ELB hostname never
  would).
- **Fix:** removed the `host:` field from the rule entirely — with none specified, the
  controller routes on *any* hostname that reaches it, including the AWS-assigned one,
  with no domain purchase required.

**Symptom:** frontend loads fine (`HTTP 200`), but `/api/products` returns an Express
default 404 page (`Cannot GET /`) instead of JSON.

- **Diagnosis:** this is the signature of a request arriving at the backend for path `/`
  when it should have been `/api/products`. The Ingress had an annotation
  `nginx.ingress.kubernetes.io/rewrite-target: /` — which, used bare like this (without
  a capture-group path pattern), rewrites the path of **every** matching request to `/`
  before forwarding it, regardless of what was actually requested.
- **Root cause:** a pre-existing bug in the manifest, never caught before because
  nothing had ever tested through a real ingress controller until this point (local
  Docker Compose and the earlier `kubectl port-forward` tests both bypassed the Ingress
  object entirely).
- **Fix:** removed the annotation. Both services already expect the original,
  unmodified path (backend's routes are mounted at `/api/...`, frontend serves
  everything else at `/`) — no rewriting was ever needed.
- **Takeaway:** `rewrite-target` is one of the most commonly cargo-culted nginx-ingress
  annotations — it's only correct when paired with a capture-group path
  (`path: /api(/|$)(.*)`, `rewrite-target: /$2`) to preserve the *matched suffix*. A bare
  `rewrite-target: /` is almost never what you actually want.

**Symptom (transient, not a bug):** the public hostname didn't resolve for several
minutes after the Load Balancer showed as provisioned.

- **Diagnosis:** `nslookup <hostname>` against the default (ISP) resolver failed
  (`Non-existent domain`); the same lookup against `8.8.8.8` (Google's public DNS)
  succeeded immediately, returning a real IP.
- **Root cause:** normal DNS propagation lag specific to one resolver's cache — not a
  problem with the load balancer, which was already correctly serving traffic (verified
  by hitting the resolved IP directly with an explicit `Host` header).
- **Takeaway:** when a freshly created public DNS name "doesn't work," check it against
  a second, independent resolver (`nslookup <name> 8.8.8.8`) before assuming the
  infrastructure itself is broken.

---

## 8. Monitoring: Prometheus + Grafana

**Goal:** real observability into the running application, not just "is the pod green."

### Steps

1. Install `kube-prometheus-stack` via Helm, using the values file the scaffold already
   shipped with (`monitoring/kube-prometheus-stack-values.yaml`) — unused until this
   point:
   ```bash
   helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
   helm install monitoring prometheus-community/kube-prometheus-stack \
     --namespace monitoring --create-namespace \
     -f monitoring/kube-prometheus-stack-values.yaml
   ```
   (This step benefited directly from Section 5's EBS CSI driver fix — both Prometheus's
   20Gi volume and Grafana's 5Gi volume need the same working `gp3` StorageClass, or
   they'd hit the identical `Pending`-PVC failure Mongo did.)
2. Apply the `ServiceMonitor` that tells Prometheus's operator where to scrape:
   `kubectl apply -f monitoring/backend-servicemonitor.yaml`.
3. Verify targets are actually being scraped — don't just trust that the `ServiceMonitor`
   object *exists*, confirm Prometheus picked it up:
   `kubectl port-forward -n monitoring svc/monitoring-kube-prometheus-prometheus 9090:9090`,
   then query `GET /api/v1/targets` and check `health: "up"` for the expected job.
4. `kubectl port-forward -n monitoring svc/monitoring-grafana 3001:80`, log in
   (`admin` / the password from the values file), import
   `monitoring/grafana-dashboard-ecom.json` — done via Grafana's own REST API
   (`POST /api/dashboards/db`) rather than the UI, for repeatability.

### Errors & Troubleshooting

**Symptom (would-be):** querying `up{job="backend-metrics"}` in Prometheus returned an
empty result, looking like the scrape wasn't configured.

- **Diagnosis:** queried `/api/v1/targets` directly and inspected every target's `job`
  label rather than guessing — found the actual value was `job="backend"`, not
  `job="backend-metrics"`. Prometheus derives the `job` label from the target
  **Service's** name by default, not from the `ServiceMonitor` object's own `metadata.name`
  (`backend-metrics` was just what the `ServiceMonitor` itself was called).
- **Takeaway:** never guess a Prometheus label name — `/api/v1/targets` (or the
  Prometheus UI's Targets page) shows you the real label set Prometheus actually
  assigned, which frequently differs from what you'd assume from the config that
  produced it.

**A genuinely interesting (non-)incident, worth documenting as a lesson in reading
metrics correctly:** once real traffic was flowing, the request-by-route breakdown
showed a hit for `/api/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php` — a
well-known automated internet vulnerability scanner probing for an old PHP/PHPUnit
remote-code-execution bug (CVE-2017-9841). Completely harmless here (this app is
Node.js, not PHP — Express just returned its own 404), but it's a real, live
demonstration that **any** public IP on the internet gets scanned by bots within
minutes of going live. It's not something to react to; it's useful precisely because it
shows the monitoring pipeline is capturing genuine, unfiltered traffic rather than
synthetic test hits.

---

## 9. AWS Console / EKS access — a permissions layer people forget exists

**Symptom:** logged into the AWS Console as the account's **root user**, the EKS
console's "Resources" tab showed no pods, deployments, or anything else — despite
`kubectl` (using a different IAM identity) working fine.

- **Diagnosis:** `aws eks list-access-entries` showed only one principal with any
  Kubernetes RBAC access: the specific IAM user that had run `terraform apply`
  (granted automatically via `enable_cluster_creator_admin_permissions = true`
  in Section 3). The root account had never been granted anything.
- **Root cause / the actual lesson:** **EKS access is a two-layer system.** AWS IAM
  permissions (what the console lets an identity *do* against the AWS API) are
  completely separate from Kubernetes RBAC (what that identity can see or do *inside*
  the cluster's own API). Being AWS account root, or having `AdministratorAccess`,
  grants unlimited AWS API access but **zero** Kubernetes-object visibility unless an
  explicit EKS "access entry" also exists for that principal.
- **Fix (explicit user confirmation obtained first — this is a real, security-relevant
  grant):**
  ```bash
  aws eks create-access-entry --cluster-name <name> --principal-arn arn:aws:iam::<account>:root --type STANDARD
  aws eks associate-access-policy --cluster-name <name> --principal-arn arn:aws:iam::<account>:root \
    --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy --access-scope type=cluster
  ```
- **Takeaway:** whenever "I have full AWS admin but I can't see my own cluster's pods"
  comes up, it's this — check `aws eks list-access-entries`, not IAM policies.

---

## 10. A note on cost visibility

AWS Cost Explorer lags real spend by 24–48 hours — it will show **$0** for anything
that happened today, which is easy to misread as "nothing is being billed." To get a
real-time estimate instead: pull exact resource creation/start timestamps directly
(`aws eks describe-cluster`, `aws ec2 describe-nat-gateways`, `aws ec2 describe-instances`
all return precise `CreatedAt`/`LaunchTime` fields), multiply by each resource's
published hourly rate, and sum. It won't be penny-exact (especially for newer instance
families without perfectly memorized pricing), but it's a far better signal than a
Cost Explorer dashboard reading zero while a NAT Gateway and an EKS control plane have
both been running for an hour.

**The ongoing burn rate that matters more than any single number:** once the EKS
control plane, NAT Gateway, worker nodes, Jenkins EC2 instance, and the ingress Load
Balancer are all up simultaneously, this stack costs real money **continuously**,
whether or not it's being actively used. If this is a portfolio/demo project rather
than something meant to run indefinitely, tear it down (`terraform destroy`, plus
manually `helm uninstall` anything installed outside Terraform — see Section 11)
when you're not actively demonstrating it.

---

## 11. What's in Git vs. what's only on the live cluster

Not everything this project depends on lives in the repository, and that's worth being
explicit about (documented in the main `README.md`'s "Path to production" too, but
repeated here for completeness):

| In Git (reproducible by cloning + running the pipeline) | **Not** in Git (manual, one-time, per-cluster) |
|---|---|
| App code, Dockerfiles, `Jenkinsfile` | The `ingress-nginx` Helm install itself |
| All of `k8s/*.yaml` (Deployments, Services, StatefulSet, Ingress, HPA, seed Job, StorageClass) | The `kube-prometheus-stack` Helm install itself |
| All of `terraform/*.tf` (VPC, EKS, ECR, EBS CSI driver + its IRSA role) | The Jenkins **server itself** (OS packages, plugin installs, credentials) — Jenkins credentials in particular can never be exported/imported this way; they're recreated by hand or API each time |
| `monitoring/*.yaml`, `*.json` (the `ServiceMonitor`, the Grafana dashboard definition) | The EKS **access entries** granting specific IAM principals RBAC access (Section 9) |

If this cluster were destroyed and rebuilt from scratch, `terraform apply` + a Jenkins
run would restore everything in the left column automatically — but someone would still
need to manually re-run the two `helm install` commands and re-grant EKS access entries
before the system was actually usable end-to-end again.

---

## 12. Per-tool checklists

Practical "is this stage actually done" checklists, distilled from the errors above —
useful as a pre-flight check on a similar project, independent of this one's specific
history.

### Docker / Docker Compose
- [ ] `package-lock.json` (or equivalent) is committed, not just present locally, if any
      Dockerfile uses `npm ci` / `yarn install --frozen-lockfile`
- [ ] Built the image and actually **ran** it against a real dependency (a real DB
      container, not just a bare `docker run`) before trusting it works
- [ ] Checked whether the final image needs build-time-only tools (npm, compilers) left
      in it — strip anything the container doesn't invoke at runtime
- [ ] Ran a vulnerability scan (Trivy or equivalent) against the actual built image, not
      just the source dependency manifest — base-image OS packages and bundled tooling
      (see Section 5, build #8/#9) won't show up in a manifest-only scan

### Git / GitHub
- [ ] After every "fix" during a debugging session: confirm with `git status` /
      `git diff origin/main..HEAD` that it was actually committed **and pushed**, not
      just edited locally — a fix that only exists on disk fixes nothing for anything
      that pulls from the remote (Section 5, build #10)
- [ ] Sensitive or environment-specific local files (kubeconfig, `.tfvars`, generated
      plan files) are in `.gitignore` *before* they're ever created, not after

### Terraform / AWS IAM
- [ ] Confirm the region Terraform will actually use (`var.aws_region` / the
      `provider` block) matches intent — don't assume it follows your CLI's default
- [ ] Before relying on a scaffold's default instance types / K8s version: check they're
      still current (`aws eks describe-cluster-versions`,
      `aws ec2 describe-instance-types --filters Name=free-tier-eligible,Values=true`)
- [ ] If `AttachUserPolicy` fails with `LimitExceeded`, that's the 10-managed-policy
      account quota, not a permissions gap — consolidate policies or use inline instead
- [ ] After any resource replacement, check the provider's own list API (not just
      `terraform state list`) for orphans left behind by a prior failed attempt

### EKS / Kubernetes
- [ ] Know before you need it: `enable_cluster_creator_admin_permissions` only grants
      RBAC to the **specific IAM principal that ran `apply`** — anyone else (including
      account root) needs an explicit `aws eks create-access-entry`
- [ ] If using EKS-managed node groups: confirm the default `gp2` StorageClass actually
      works on your cluster version — it doesn't, past a certain Kubernetes version,
      without the `aws-ebs-csi-driver` addon installed and a CSI-based StorageClass
- [ ] `StatefulSet.spec.volumeClaimTemplates` is immutable after creation — plan the
      correct fields (including `storageClassName`) *before* first apply, not after
- [ ] `kubectl apply` on a Deployment with a literal/placeholder `image:` will reset it
      on every run if anything else (like `kubectl set image`) changes it out-of-band —
      template the real value in before applying, don't apply-then-patch

### Jenkins
- [ ] The service account running pipeline steps (usually `jenkins`) is in the `docker`
      group if any step runs `docker build`/`docker run`
- [ ] Every `credentialsId` referenced in the `Jenkinsfile` exists with an **exact**
      matching ID, of the **exact** matching type (Secret text vs. Secret file vs.
      Username/password) — a "close enough" ID silently fails at bind time, not at
      pipeline-parse time
- [ ] If a `withCredentials` block's shell script authenticates to a *second* system
      indirectly (e.g. a kubeconfig that itself shells out to `aws eks get-token`), that
      second system's credentials need to be bound too, not just the first
- [ ] Confirm the base OS actually has every tool the pipeline's `sh` steps assume
      (`node`, `npm`, `trivy`, `terraform`, `aws`, `kubectl`, `git`) — don't assume from
      the Jenkinsfile's own header comments; check the box directly
- [ ] If ECR (or any registry) has immutable tags, don't push a floating tag
      (`:latest`) alongside immutable commit-SHA tags — they're incompatible

### Ingress / networking
- [ ] Any `host:` rule in an `Ingress` matches a domain you actually control (or has no
      host filter at all, if using the load balancer's own DNS name)
- [ ] Any `rewrite-target` annotation is paired with a capture-group path pattern — a
      bare `rewrite-target: /` rewrites *every* request path, breaking any backend
      routing that depends on the original path
- [ ] Test through the **actual** ingress path end-to-end, not just via
      `kubectl port-forward` (which bypasses the Ingress object entirely and won't catch
      Ingress-specific bugs)
- [ ] If a fresh public DNS name "doesn't resolve," check it against a second resolver
      (e.g. `8.8.8.8`) before assuming the infrastructure is broken

### Monitoring (Prometheus / Grafana)
- [ ] Confirm scrape targets are actually `health: "up"` via the Prometheus API/UI
      directly — don't infer it from the `ServiceMonitor` object merely existing
- [ ] Check the **actual** `job` label Prometheus assigned (from `/api/v1/targets`),
      not the name you expect from the `ServiceMonitor`'s own metadata — they often
      differ
- [ ] Any PVC-backed component (Prometheus's TSDB, Grafana's dashboards) needs the same
      working StorageClass as everything else — verify it, don't assume

---

*Written from a real, single build-out session on a fresh AWS account (`ap-south-1`),
kept in this repo so the reasoning behind each decision — and the exact shape of every
error hit along the way — stays attached to the code it describes.*
