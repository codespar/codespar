# Deploy — codespar

This repo provides the Railway service **`codespar`** (OSS runtime, MIT). In staging, `ENABLE_WHATSAPP=false` (WhatsApp channel off — the staging Evolution API service is at `NO DEPLOYMENT` to keep cost at zero).

## Staging

```bash
# from repo root, with desired branch checked out
railway environment staging
railway up -s codespar
```

`railway up` packages the current working tree and uses the root `Dockerfile`. Logs:

```bash
railway service logs -s codespar
```

In staging, the runtime points to `api.staging.codespar.dev` automatically via env vars in the `staging` environment. No public URL (internal service).

## Production

Tag-based: a `v*` tag publishes an image to GHCR (`.github/workflows/publish-docker.yml`); Railway pulls it for the service:

```bash
git tag v0.x.y && git push origin v0.x.y
# OR run the "Publish Docker image" workflow manually with workflow_dispatch
```

## Re-enable WhatsApp in staging (if ever needed)

```bash
railway environment staging
railway variables -s codespar --set "ENABLE_WHATSAPP=true"
railway up -s calm-prosperity     # bring Evolution API back up (currently NO DEPLOYMENT)
# pair a new WhatsApp Business instance with the staging Evolution (QR code)
```

## Prerequisites

- `railway login` + `railway link --project codespar`
