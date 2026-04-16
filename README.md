# EduTrack API (APP version V.0 stable - test E2E & GitHub Actions ok sans tests manuelle)

[![CI](https://github.com/Sergebilly100/edutrack-api/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Sergebilly100/edutrack-api/actions/workflows/ci.yml)

Backend API for EduTrack CI.

Replace `Sergebilly100/edutrack-api` with the real GitHub repository slug.

## Integration Tests Setup

Integration tests use `DATABASE_URL_TEST` and fallback to `DATABASE_URL` when `DATABASE_URL_TEST` is not set.
Tests are isolated by tenant schema (`school_test_*`), then cleaned up.

### 1) Start local dependencies

```bash
cd edutrack-api
docker compose up -d postgres redis
```

### 2) Configure env

Recommended:

```bash
cp .env.example .env
```

Or set only required test variables:

```bash
export DATABASE_URL_TEST=postgresql://edutrack:edutrack@localhost:5432/edutrack
export JWT_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'
export JWT_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----'
```

### 3) Run tests

Run full integration suite:

```bash
npm run test:integration
```

Run A3-only integration coverage:

```bash
npm run test:integration:a3
```
