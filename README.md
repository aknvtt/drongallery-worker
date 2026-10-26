# drongallery-worker

Watermark worker for a self-hosted drone photo gallery. It runs in GitHub Actions (free for public repositories) and
contains no secrets, ids, e-mail addresses or file names: configuration comes from repository secrets and nothing about
the media is ever printed to the logs.

## What it does

The gallery site starts the `watermark` workflow (`workflow_dispatch`) whenever watermark jobs are queued. The worker then:

1. asks the site for the next job over an HMAC-signed request (`/api/worker/next`),
2. gets a short-lived Google Drive access token for that job only (`/api/worker/token`),
3. downloads the original and the logo, renders the watermarked copy
   (photos with `sharp`, videos with `ffmpeg`/H.264, CRF 18, audio copied),
4. strips all metadata and **fails the job if any GPS tag is still present** (`exiftool`),
5. uploads the copy to Drive and reports its id (`/api/worker/complete`). The site re-verifies the file before using it.

It repeats until the queue is empty and then exits. Only one run is active at a time (`concurrency`).

## Requests are authenticated

Every request carries `x-ts`, `x-nonce` and `x-signature` = HMAC-SHA256 over
`METHOD \n path \n timestamp \n nonce \n sha256(body)`. The site accepts a 5 minute window and each nonce only once.

## Setup

Repository secrets:

| Secret | Value |
|---|---|
| `GALLERY_SITE_URL` | `https://` URL of the gallery site |
| `WORKER_HMAC_SECRET` | the same random 32+ character secret configured on the site |

The site triggers the workflow with a fine-grained personal access token limited to this repository
(Actions: read and write).

## Local checks

`overlay-math.mjs` positions the logo; the gallery site has a TypeScript twin used for the live preview and a test that
asserts both produce identical rectangles.

License: MIT
