# DeckWise downloads

Standalone static download page maintained with DeckWise, independent of the
OpenResty configuration repository. No package installation or build is needed.

Deploy this directory to `/home/app/deckwise-downloads`. TrainWise OpenResty
mounts it read-only at `/var/www/deckwise` and serves it at
`https://trainwise.efrobot.com/deckwise/`.

The page loads `/deckwise/downloads.json`, which proxies the public OSS release
manifest. The DeckWise release workflow generates the manifest from all seven
nonempty installers and uploads it only after the binaries and update feeds.
Download links point directly to OSS, so installers do not pass through Nginx.

Until the first manifest-enabled release, an OSS 404 uses the checked-in
`downloads-bootstrap.json` with verified 0.17.4 installers. Other upstream
errors remain visible as a retryable error on the page.

The page uses the existing DeckWise logo. SVG icons are generated from the
project's installed Lucide library (ISC license).

## Local Preview

Serve the repository directory and open `/download-page/`. During local
preview, map `downloads.json` to `downloads-bootstrap.json`; production makes
this mapping only when OSS returns 404.

## Deployment

Sync this directory separately from `trainwise-openresty`. Then validate the
configuration and recreate OpenResty to add the read-only volume:

```bash
cd /home/app/trainwise-openresty
docker compose config --quiet
docker compose up -d openresty
docker exec openresty nginx -t
curl -I https://trainwise.efrobot.com/deckwise/
curl -f https://trainwise.efrobot.com/deckwise/downloads.json
```

Later static file updates need no restart. Nginx configuration changes require
validation and a reload. Unknown `/deckwise/` paths return 404.

## Browser Check

Run `node verify-page.cjs <page-url>` with Playwright installed, or set
`PLAYWRIGHT_MODULE` to an existing Playwright module path. The check covers
desktop/mobile layouts, image loading, download links, FAQ, errors and retries.
