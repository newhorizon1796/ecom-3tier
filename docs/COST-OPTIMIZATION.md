# Cost Optimization for Projects Like This

This isn't generic "10 AWS cost tips" — it's specifically about the cost shape of a
**Kubernetes-based reference/demo project**: fixed control-plane costs, a networking
tax that's easy to miss, and a lifecycle problem (infrastructure that costs money
whether or not anyone's looking at it) that a pure SaaS app doesn't have. See
[`HANDBOOK.md` §10](HANDBOOK.md#10-a-note-on-cost-visibility) for how this project's
actual spend was tracked during build-out.

## 1. Know your cost shape before optimizing anything

Every dollar this stack spends falls into one of two categories, and they need
opposite strategies:

- **Fixed, size-independent costs** — the EKS control plane (a flat $0.10/hour no
  matter how small your workload is), the NAT Gateway (a flat hourly rate plus data
  processing), the KMS key (~$1/month). These don't get cheaper by right-sizing
  anything — the only lever is *not having them* when you don't need them.
- **Scalable, usage-proportional costs** — worker node EC2 instances, EBS volumes,
  data transfer. These respond to right-sizing, autoscaling, and choosing cheaper
  purchase options.

Confusing the two is the most common mistake: spending time tuning HPA thresholds
(a scalable cost) while a NAT Gateway sits there billing the same flat rate whether
it's a demo or in real 24/7 production use.

## 2. The single biggest lever: don't run it when you're not using it

For a demo/portfolio project — as opposed to something serving real users around the
clock — this beats every other optimization combined. This project's own EKS control
plane + 2 worker nodes + NAT Gateway + Load Balancer, left running continuously, cost
roughly **$375–400/month** by the estimate done mid-build (Section 10 of the
handbook). The same stack, spun up for an hour to demo and torn down after
(`terraform destroy`, as done in this project's own final step), costs a few dollars.

Practical pattern for a project like this:
- Keep the Terraform + Helm setup in the repo (as this one does), so standing the
  whole thing back up is a documented, repeatable sequence, not a from-scratch effort
  each time.
- Actually tear it down (`terraform destroy` + the two `helm uninstall`s — see
  `HANDBOOK.md` §11 for the exact order, since getting it wrong orphans a Load
  Balancer or an EBS volume) when you're done demoing it, not "when I remember to."
- If you show it off regularly (interviews, portfolio reviews), consider scripting the
  whole stand-up as one command so the friction of tearing it down is genuinely low.

## 3. Compute: the worker nodes

- **Right-size the instance type to the actual workload**, not a round number picked
  by habit. This project runs a handful of small pods (2× Node.js backend, 2× nginx
  frontend, 1× MongoDB) — `m7i-flex.large` (2 vCPU / 8 GiB) per node, ×2 nodes, is
  generous for that footprint. A smaller type would be cheaper if your account's
  instance-type restrictions allow it (see `HANDBOOK.md` §3 for why this project
  specifically couldn't use `t3.medium` — check what your own account actually allows
  before assuming a "standard" small instance is available).
- **Spot instances** for anything that can tolerate interruption (`capacity_type =
  "SPOT"` on an `eks_managed_node_groups` entry in `terraform/eks.tf`) — typically
  60–90% cheaper than on-demand. Not appropriate for this project's single-replica
  MongoDB (a Spot interruption mid-write risks data loss on the one pod holding state),
  but the stateless backend/frontend pods would tolerate it fine on a separate node
  group.
- **Cluster Autoscaler or Karpenter** to actually scale node *count* down during idle
  periods — this project's HPA (`backend-hpa`) scales *pods* between 2–6 replicas based
  on CPU, but nothing scales the underlying *nodes* down when load drops. Without a
  node-level autoscaler, HPA scaling down just leaves emptier nodes still billing at
  full price.
- **EKS Fargate** as an alternative to managed node groups entirely, for spiky or very
  small workloads — you pay per-pod-second instead of per-node-hour, so there's no idle
  node cost at all. Worth it once workloads are small/bursty enough that "no idle
  capacity, ever" beats "cheaper compute, but some idle capacity."

## 4. Networking: the tax nobody remembers to check

- **The NAT Gateway is usually the most underestimated line item** in a private-subnet
  EKS setup — a flat hourly rate *plus* per-GB data processing, and it's easy to forget
  it exists because it's not a "workload" resource. This project already applies the
  cheapest reasonable configuration (`single_nat_gateway = true` in `terraform/vpc.tf`
  — one NAT Gateway shared across AZs, instead of the HA-but-3x-cost pattern of one per
  AZ). For a genuine production workload needing AZ-level NAT redundancy, that's the
  right tradeoff to reconsider; for a demo, keep it at one.
- **VPC endpoints** (Gateway endpoints for S3, Interface endpoints for ECR) let traffic
  to those specific AWS services skip the NAT Gateway's per-GB data-processing charge
  entirely, routing directly instead. Worth adding if you're pulling large images from
  ECR repeatedly (every `docker pull` inside the cluster) — this project's images are
  small enough that it doesn't matter yet, but it would at scale.
- **Public Load Balancer** (from `ingress-nginx`, per `HANDBOOK.md` §7): a flat hourly
  rate plus data processing, same shape as the NAT Gateway. If you only need to *show*
  the app occasionally rather than keep it always reachable, this is another candidate
  for "provision it for the demo, tear it down after" rather than leaving it up.

## 5. Storage

- **`gp3` over `gp2`** for any EBS-backed volume (this project's `StorageClass`,
  `k8s/storageclass.yaml`, already defaults to `gp3`) — cheaper per-GB and
  independently tunable IOPS/throughput, versus `gp2`'s baseline tied to volume size.
- **Reclaim policy matters for both cost and safety.** `Delete` (this project's
  default) means the EBS volume is destroyed automatically when its `PersistentVolumeClaim`
  is deleted — no orphaned volumes silently billing after a teardown, but also no
  recovery if that PVC deletion was a mistake. For anything with data you can't afford
  to lose, use `Retain` and clean up manually — accept the small ongoing cost of an
  orphaned volume as the price of a safety net.
- **Tune retention windows to actual need.** `monitoring/kube-prometheus-stack-values.yaml`
  sets Prometheus's retention to 15 days on a 20Gi volume — reasonable for active
  development, but if this were left running long-term with nobody looking at metrics
  from 2 weeks ago, a shorter retention (or a smaller volume) costs less for the same
  practical value.

## 6. Container registry (ECR)

- **Lifecycle policies to auto-expire what you don't need to keep.**
  `terraform/ecr.tf` already has one: untagged images (left behind when a tag gets
  reused, though this project's repos are `IMMUTABLE` so that's less of a concern
  here — see `HANDBOOK.md` §6) expire after 14 days. Consider adding a policy for old
  **tagged** images too if you don't need indefinite build history — e.g., "keep the
  last 20 tagged images, expire the rest."
- Storage itself is cheap per-GB, but it's not free, and it compounds silently across
  months of daily CI builds if nothing ever expires.

## 7. CI infrastructure (Jenkins)

- **A static, always-on EC2 instance for Jenkins is the simplest setup and the most
  wasteful one** if builds are infrequent — you're paying for compute 24/7 to run
  builds that might take 10 minutes a day. This project's Jenkins box (`terra-practice`)
  was, in fact, *stopped* between sessions before this build-out started — that's the
  right instinct, just needs to be deliberate rather than incidental.
- For anything beyond a personal demo: consider **ephemeral build agents** (Jenkins'
  Kubernetes plugin spins up a pod-per-build, torn down after) instead of a persistent
  EC2 controller-and-agent-in-one — you only pay for compute during an actual build,
  not between them.

## 8. Make cost visible, don't just guess at it

- **Tag everything** with `Project` / `Environment` (already done throughout this
  project's Terraform — every resource block includes a `tags` argument) so Cost
  Explorer can actually break spend down by project instead of showing one undifferentiated
  account total.
- **Set an AWS Budget with an alert** — a low-friction safety net that emails you before
  a forgotten-and-still-running stack quietly racks up a real bill. Takes five minutes
  to set up once; this project didn't have one, and its cost tracking during build-out
  relied on manually pulling resource timestamps instead (workable for a single active
  session, not a substitute for an ongoing alert).
- **Remember Cost Explorer lags 24–48 hours** (`HANDBOOK.md` §10) — for same-day
  confidence that nothing's running, check actual resources
  (`aws eks list-clusters`, `aws ec2 describe-instances`, etc.), not the billing
  dashboard, which will under-report anything from today or yesterday.

## 9. What doesn't apply here (but will, if this goes to production)

Reserved Instances / Savings Plans, multi-year commitments, and Compute Optimizer's
right-sizing recommendations all assume a **stable, long-running** workload — they're
not relevant to a project you spin up and tear down for demos. If this ever became a
real, continuously-running service instead of a portfolio piece, that's the point to
revisit this list with an eye toward committed-use discounts instead of "turn it off
when not needed."
