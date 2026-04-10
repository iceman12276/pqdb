# PRD: Phase 5b — AWS Deployment

## Context

pqdb currently runs locally via Docker Compose (Postgres, Vault, Caddy) with backend/dashboard/MCP on the host. Phase 5b deploys everything to AWS using ECS Fargate, RDS, S3+CloudFront, and Secrets Manager — as decided during the deploy-on-aws analysis.

## Introduction

Phase 5b containerizes pqdb and deploys it to AWS. The backend and MCP server run on ECS Fargate with Caddy sidecar for PQC TLS. The dashboard is built as static files and served from S3+CloudFront. HashiCorp Vault is replaced by AWS Secrets Manager. Infrastructure is defined as CDK code.

## Goals

1. All three services (backend, MCP, dashboard) running on AWS
2. Vault replaced by Secrets Manager — no hvac dependency in production
3. RDS PostgreSQL 16 with pgvector for all databases
4. Automated deployment on merge to main via GitHub Actions
5. Local dev continues to work with Docker Compose

## User Stories

### US-112: Containerfiles for backend and MCP server

**Description:** As the system, I need container images for the backend API and MCP server so they can run on ECS Fargate.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `backend/Containerfile` — multi-stage build: Python 3.12, uv for deps, copies src, runs uvicorn. Includes liboqs system deps (cmake, gcc) for ML-DSA-65
- [ ] `mcp/Containerfile` — multi-stage build: Node 22-alpine, npm ci, copies dist, runs node cli.js
- [ ] `infra/caddy/Containerfile` — Caddy with custom Caddyfile for production (domain-based, not localhost)
- [ ] All three images build successfully: `docker build -t pqdb-backend backend/` etc.
- [ ] Backend container starts and responds to `/health` on port 8000
- [ ] MCP container starts and responds on port 3002
- [ ] Caddy container proxies to backend and dashboard correctly
- [ ] Images are reasonably sized (backend < 500MB, MCP < 200MB, Caddy < 50MB)
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds

### US-113: Secrets Manager migration — replace Vault with boto3

**Description:** As the system, I need to store and retrieve secrets from AWS Secrets Manager instead of HashiCorp Vault so the app works on AWS without running Vault.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] New `backend/src/pqdb_api/services/secrets.py` with `SecretsProvider` abstract class and two implementations: `VaultSecretsProvider` (existing hvac logic) and `AWSSecretsProvider` (boto3)
- [ ] `AWSSecretsProvider` implements: `store_hmac_key()`, `get_hmac_keys()`, `rotate_hmac_key()`, `delete_hmac_key_version()`, `store_oauth_credentials()`, `get_oauth_credentials()`, `get_platform_oauth_credentials()`, `list_oauth_providers()`, `delete_oauth_credentials()`
- [ ] Secret paths: `pqdb/projects/{project_id}/hmac`, `pqdb/projects/{project_id}/oauth/{provider}`, `pqdb/platform/oauth/{provider}`
- [ ] Provider selected by config: `PQDB_SECRETS_BACKEND=vault|aws` (default: vault for backward compat)
- [ ] `app.py` lifespan initializes the correct provider based on config
- [ ] All existing Vault tests pass unchanged with `VaultSecretsProvider`
- [ ] New integration tests for `AWSSecretsProvider` using moto (AWS mock library) or LocalStack
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Service responds to health check

### US-114: Dashboard static build for S3+CloudFront

**Description:** As the system, I need the dashboard to build as static files so it can be served from S3+CloudFront.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Dashboard Vite config updated to produce a client-only SPA build (no SSR)
- [ ] `npm run build` outputs to `dashboard/dist/` with index.html + hashed JS/CSS assets
- [ ] All routes handled by client-side routing (SPA fallback to index.html)
- [ ] API calls use relative paths (`/v1/*`) — no hardcoded localhost URLs
- [ ] Environment variable `VITE_API_URL` configurable for production domain
- [ ] Build output works when served from a static file server: `npx serve dist/`
- [ ] All existing dashboard tests pass
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds

### US-115: CDK infrastructure stack

**Description:** As the system, I need AWS infrastructure defined as CDK code so it can be deployed reproducibly.

**Dependencies:** US-112, US-113, US-114

**Acceptance Criteria:**
- [ ] New `infra/cdk/` directory with TypeScript CDK project
- [ ] VPC stack: VPC with public subnets (dev config, no NAT gateway)
- [ ] Database stack: RDS PostgreSQL 16 (db.t4g.micro) with pgvector extension enabled, in VPC
- [ ] Backend stack: ECS Fargate service with backend + Caddy sidecar task definition, ALB target group for `/v1/*` and `/health`
- [ ] MCP stack: ECS Fargate service for MCP server, ALB target group for `/mcp/*`
- [ ] Dashboard stack: S3 bucket + CloudFront distribution with SPA routing (404→index.html)
- [ ] Secrets: Secrets Manager secrets for DATABASE_URL, JWT keys, HMAC seed
- [ ] IAM: Task execution role with ECR pull + Secrets Manager read + CloudWatch logs
- [ ] ECR repositories for backend, MCP, and Caddy images
- [ ] ALB with HTTPS listener (ACM certificate)
- [ ] `cdk synth` produces valid CloudFormation template
- [ ] `cdk diff` shows expected resources
- [ ] Unit tests for CDK constructs (snapshot tests)
- [ ] CI passes
- [ ] Typecheck passes

### US-116: CI/CD pipeline — build, push, deploy

**Description:** As the system, I need GitHub Actions to automatically build container images, push to ECR, and deploy to ECS on merge to main.

**Dependencies:** US-115

**Acceptance Criteria:**
- [ ] New GitHub Actions workflow `.github/workflows/deploy.yml`
- [ ] Triggers on push to main (after CI passes)
- [ ] Steps: build backend/MCP/Caddy images → push to ECR → update ECS service (force new deployment)
- [ ] Dashboard: `npm run build` → sync to S3 → invalidate CloudFront cache
- [ ] Alembic migrations: run `alembic upgrade head` against RDS before deploying new backend
- [ ] AWS credentials via GitHub OIDC (no stored access keys)
- [ ] Deployment rolls back if health check fails (ECS deployment circuit breaker)
- [ ] Workflow uses environment secrets for AWS account ID, region, domain
- [ ] CI passes
- [ ] Typecheck passes

### US-117: Production configuration and health verification

**Description:** As a developer, I want to verify the deployed app works end-to-end on AWS.

**Dependencies:** US-116

**Acceptance Criteria:**
- [ ] Production Caddyfile uses real domain instead of localhost
- [ ] CORS origins updated for production domain
- [ ] WebAuthn RP ID and origin updated for production domain
- [ ] Backend `/health` and `/ready` return 200 through ALB
- [ ] Dashboard loads through CloudFront
- [ ] Developer signup/login works end-to-end
- [ ] Project creation provisions RDS database
- [ ] HMAC keys stored in Secrets Manager (not Vault)
- [ ] Table creation + CRUD works through the deployed backend
- [ ] MCP server OAuth flow works with production URLs
- [ ] CI passes
- [ ] Typecheck passes

## Functional Requirements

- **FR-1:** Backend and MCP run as ECS Fargate tasks with Caddy sidecar for PQC TLS
- **FR-2:** Dashboard served as static files from S3 via CloudFront CDN
- **FR-3:** All secrets stored in AWS Secrets Manager, Vault used only for local dev
- **FR-4:** RDS PostgreSQL 16 with pgvector for platform + project databases
- **FR-5:** Automated deployment on merge to main
- **FR-6:** Infrastructure defined as CDK TypeScript code

## Non-Goals

- Multi-region deployment (deferred)
- Per-project container isolation / EKS (deferred — start with Fargate)
- Custom domain setup (use ALB/CloudFront default URLs initially)
- WAF / DDoS protection (dev config)
- Auto-scaling (single task per service for dev)
- Production-grade monitoring (CloudWatch basic only)

## Technical Considerations

### Caddy Sidecar for PQC TLS
AWS ALB doesn't support PQC TLS. Caddy runs as a sidecar container in the same Fargate task, terminates TLS with X25519MLKEM768, and forwards to the backend on localhost. ALB uses HTTP to reach Caddy's HTTPS port.

### SecretsProvider Abstraction
Dual backend (Vault for local, Secrets Manager for AWS) via abstract class. Config flag `PQDB_SECRETS_BACKEND` selects the implementation. This keeps local dev unchanged while production uses native AWS.

### Dashboard SPA Conversion
TanStack Start's SSR needs to be disabled for S3+CloudFront static hosting. This is a Vite config change — switch to client-only rendering with hash-based routing and a CloudFront 404→index.html rule.

### Estimated Monthly Cost (Dev)
| Service | Cost |
|---------|------|
| ECS Fargate (backend) | ~$15/mo |
| ECS Fargate (MCP) | ~$8/mo |
| RDS PostgreSQL | ~$15/mo (free tier year 1) |
| S3 + CloudFront | ~$1/mo |
| Secrets Manager | ~$4/mo |
| ALB | ~$16/mo |
| **Total** | **~$59/mo** |

## Dependency Graph

```
Chain A: US-112 (Containerfiles) ──┐
Chain B: US-113 (Secrets Manager) ─┼→ US-115 (CDK) → US-116 (CI/CD) → US-117 (Verification)
Chain C: US-114 (Dashboard SPA) ──┘
```

Three independent starting points: US-112, US-113, US-114
Then sequential: US-115 → US-116 → US-117
