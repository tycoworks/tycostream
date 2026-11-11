# Contributing

Bug reports, ideas, and pull requests are welcome. For anything bigger than a small fix, open an [issue](https://github.com/tycoworks/tycostream/issues) first, so we can agree on the approach before you write the code.

## Building from source

You'll need Node.js 24 or later, and Docker for the end-to-end tests.

```bash
git clone https://github.com/tycoworks/tycostream.git
cd tycostream
npm install
npm run build
npm start
```

`npm start` reads its [settings](docs/guide.md#step-2-run-tycostream) from your environment or a `.env` file, and `schema.yaml` from the current folder.

## Testing

```bash
npm test             # unit tests
npm run test:utils   # tests for the test helpers
npm run e2e          # end-to-end tests, against Materialize in Docker
npm run lint
```

The [e2e readme](test/E2E-README.md) covers each suite. CI runs lint, the build, the tests, and a Docker build on every pull request, and a pull request merges only once they pass.

## Pull requests

- Branch from `main`, and keep each commit to one change.
- Write commit messages in [Conventional Commits](https://www.conventionalcommits.org/) style, saying what changed, such as `fix: the schema generator stopped at its first source under bash 4.1+`.
- A pre-commit hook runs ESLint on the files you change.
- Follow the code standards in [implementation.md](docs/implementation.md). [architecture.md](docs/architecture.md) explains how tycostream is built.

## Releasing

Releases follow semantic versioning. To release, set the version in `package.json`, merge it, and push a matching tag, such as `v0.5.0`. The release workflow checks the tag, publishes the Docker image to GHCR, and drafts the GitHub release for you to edit and publish.
