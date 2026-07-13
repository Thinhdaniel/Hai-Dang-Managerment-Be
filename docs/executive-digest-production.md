# Executive Visual Digest - production setup

## 1. Render environment

The feature works without image generation. In that mode it uses a real maintenance photo as the cover when one is available.

```env
VERTEX_IMAGE_ENABLED=false
VERTEX_MODEL_IMAGE=gemini-3.1-flash-image
```

Enable image generation only after the VM proxy implements the endpoint below:

```env
VERTEX_IMAGE_ENABLED=true
VERTEX_MODEL_IMAGE=gemini-3.1-flash-image
```

Existing variables are still required:

```env
VERTEX_ENABLED=true
VERTEX_PROXY_URL=https://ai-router.haidangms.com/vertex
VERTEX_PROXY_KEY=<same-secret-as-the-vm-proxy>
CLOUDINARY_CLOUD_NAME=<cloud-name>
CLOUDINARY_API_KEY=<api-key>
CLOUDINARY_API_SECRET=<api-secret>
```

## 2. Vertex VM proxy contract

The backend calls:

```http
POST /image/generate
x-vertex-proxy-key: <secret>
Content-Type: application/json
```

Request:

```json
{
  "prompt": "...",
  "model": "gemini-3.1-flash-image",
  "aspectRatio": "4:5",
  "imageSize": "1K",
  "images": ["https://.../before.jpg", "https://.../after.jpg"]
}
```

The proxy must call Vertex AI `generateContent` with text plus optional image parts and return the first generated image as base64. The response accepted by this repository is:

```json
{
  "provider": "vertex",
  "model": "gemini-3.1-flash-image",
  "latencyMs": 1800,
  "images": [
    {
      "base64": "iVBORw0KGgo...",
      "mimeType": "image/png"
    }
  ]
}
```

Do not expose the proxy key in the frontend. The Render backend is the only caller.

## 3. Scheduled generation when Render sleeps

The internal endpoint creates a **draft** and notifies director-level users that it is waiting for approval:

```http
POST /api/internal/executive-digest
x-internal-cron-secret: <INTERNAL_CRON_SECRET>
Content-Type: application/json

{"type":"week"}
```

Use the Google Cloud VM cron for deterministic scheduling. UptimeRobot can wake Render but cannot guarantee that an in-process cron missed during sleep is replayed.

Example VM cron entries (Vietnam time must be accounted for if the VM uses UTC):

```cron
# Monday 00:05 UTC = Monday 07:05 Asia/Ho_Chi_Minh
5 0 * * 1 curl -fsS -X POST https://<render-backend>/api/internal/executive-digest -H 'x-internal-cron-secret: <secret>' -H 'Content-Type: application/json' -d '{"type":"week"}'

# First day of month 00:35 UTC = 07:35 Asia/Ho_Chi_Minh
35 0 1 * * curl -fsS -X POST https://<render-backend>/api/internal/executive-digest -H 'x-internal-cron-secret: <secret>' -H 'Content-Type: application/json' -d '{"type":"month"}'
```

The app keeps up to 12 prior revisions for each period. Regeneration always creates a new draft; it never silently replaces an approved or published version.

## 4. V2 editorial and official PDF flow

The production workflow is intentionally server-enforced:

1. A generated digest starts as `draft` with a deterministic validation result.
2. Editorial changes increment `contentRevision`, reset any draft artifact and append an edit-history entry.
3. Critical validation issues block approval. Warnings remain visible but can be accepted by the director.
4. Publishing an approved digest renders a new A4 PDF on the backend before changing the status to `published`.
5. The PDF is uploaded to Cloudinary as an `authenticated` raw asset. The frontend never receives a public Cloudinary URL; it downloads through the authorized digest API.
6. Published content is immutable. A correction must be generated as a new digest version, preserving the old PDF and revision.

No extra environment variable is required for V2. The existing Cloudinary API credentials must allow authenticated raw uploads. Verify the Render service has enough memory to render a PDF; the renderer streams into memory and the current report is capped to operational summary rows rather than unbounded data.

Official download endpoint (director and above only):

```http
GET /api/digests/:id/pdf
GET /api/digests/:id/pdf?version=2
```

Publishing records the number of in-app notifications, successful Web Push deliveries, successful Telegram deliveries and failed channel attempts. Opening a published digest records a deduplicated view receipt; repeated opens within five minutes do not inflate the view count.

## 5. Production acceptance check

- Generate a weekly draft and confirm validation is not `blocked`.
- Edit narrative and hide one detail row; confirm `contentRevision` increases and preview/PDF both omit that row.
- Upload a cover and regenerate an AI cover once to verify both paths.
- Approve, then publish. Confirm the response contains an artifact with `status=ready` before the digest becomes `published`.
- Download the official PDF while logged in and verify Vietnamese text, page footer, A4 dimensions and page count.
- Open the same digest from a second director account and verify the unique viewer count increases once.
- Regenerate the same period and verify the published revision and its PDF remain available from version history.
