# Vertex proxy

This is the source deployed to `/home/hieu707203/vertex-proxy/server.js` on the Google Cloud VM.

It exposes two key-authenticated endpoints on `127.0.0.1:30128`:

- `POST /generate` for text and multimodal understanding.
- `POST /image/generate` for Gemini image generation.

The image route uses the global Vertex endpoint because `gemini-3.1-flash-image` is globally available. Remote reference images are restricted to configured HTTPS hosts and a 7 MB inline limit.

Optional VM environment variables:

```env
VERTEX_IMAGE_LOCATION=global
VERTEX_IMAGE_MODEL=gemini-3.1-flash-image
VERTEX_IMAGE_FETCH_TIMEOUT_MS=180000
VERTEX_ALLOWED_IMAGE_MODELS=gemini-3.1-flash-image,gemini-2.5-flash-image
VERTEX_REFERENCE_IMAGE_HOSTS=res.cloudinary.com
```

Deploy from the repository checkout or copy the file to the VM, validate it with `node --check`, then restart the existing PM2 process:

```bash
pm2 restart vertex-proxy --update-env
pm2 save
```

Run the image smoke test on the VM without printing the proxy key or generated base64:

```bash
node smoke-test.js
```
