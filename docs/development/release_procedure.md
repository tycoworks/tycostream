# Release Procedure

## Current Release: Developer Preview
**Version:** `v0.1.0-preview`  
**Type:** Pre-release  
**Target Date:** TBD

## Release Actions

### 1. Documentation
- [ ] Create `/docs/user/guide.md` - Single comprehensive guide covering:
  - Getting Started
  - Configuration (env vars, schema.yaml)
  - GraphQL API examples
  - Troubleshooting
- [ ] Create `RELEASE_NOTES.md` in root (temporary file for GitHub release)

### 2. Pre-Release Checks
- [ ] Tests passing: `npm test` and `npm run e2e`
- [ ] Demo working: `npm run demo`
- [ ] Update version in package.json to `0.1.0-preview`
- [ ] Update README.md with link to guide and Docker instructions

### 3. Create Release
```bash
# Commit all changes first
git add .
git commit -m "Prepare v0.1.0-preview release"
git push origin main

# Tag and push
git tag -a v0.1.0-preview -m "Developer Preview"
git push origin v0.1.0-preview

# Create GitHub release as draft (review before publishing)
gh release create v0.1.0-preview \
  --title "v0.1.0-preview" \
  --notes-file RELEASE_NOTES.md \
  --prerelease \
  --draft

# This will output a URL like:
# https://github.com/tycoworks/tycostream/releases/tag/untagged-abc123
```

### 4. Publish Docker Image
```bash
# Build and test locally
docker build -t tycoworks/tycostream:v0.1.0-preview .

# Test that it runs (Ctrl+C to stop)
docker run -p 4000:4000 --env-file .env tycoworks/tycostream:v0.1.0-preview

# Login to Docker Hub (need account at hub.docker.com)
docker login

# Tag and push both versions
docker tag tycoworks/tycostream:v0.1.0-preview tycoworks/tycostream:latest
docker push tycoworks/tycostream:v0.1.0-preview
docker push tycoworks/tycostream:latest

# Verify at: https://hub.docker.com/r/tycoworks/tycostream
```

### 5. Final Steps
```bash
# View and edit draft release in browser
gh release view v0.1.0-preview --web

# OR publish draft from command line
gh release edit v0.1.0-preview --draft=false

# Close milestone (do this on GitHub web UI - no CLI command)
# Go to: https://github.com/tycoworks/tycostream/milestones

# Clean up temporary file
rm RELEASE_NOTES.md
```

### 6. Announce Release
- [ ] Draft blog post/announcement (optional for dev preview)
- [ ] Share on relevant forums (Materialize community, Hacker News, etc.)
- [ ] Tweet/social media (if applicable)