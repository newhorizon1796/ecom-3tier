# Monitoring: Prometheus + Grafana

This stack is installed via the community `kube-prometheus-stack` Helm chart,
which bundles Prometheus Operator, Prometheus, Alertmanager, and Grafana.

## Install

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  -f monitoring/kube-prometheus-stack-values.yaml
```

## Wire up the backend's /metrics endpoint

```bash
kubectl apply -f monitoring/backend-servicemonitor.yaml
```

The backend already exposes Prometheus-format metrics at `/metrics`
(`backend/src/metrics.js`), and its Deployment carries
`prometheus.io/scrape: "true"` annotations as a fallback for setups without
the Prometheus Operator.

## Access Grafana

```bash
kubectl -n monitoring port-forward svc/monitoring-grafana 3001:80
# open http://localhost:3001  (default user: admin, password: see values file)
```

Import `monitoring/grafana-dashboard-ecom.json` (Dashboards → New → Import →
Upload JSON) to get request rate, error rate, and p95 latency panels for the
backend API.

## Alerting (optional)

Add `PrometheusRule` resources under this directory and Alertmanager (already
deployed by the chart) will pick them up automatically; wire a receiver
(Slack/email/PagerDuty) in `kube-prometheus-stack-values.yaml` under
`alertmanager.config`.
