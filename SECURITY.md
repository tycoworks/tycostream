# Security

Report a vulnerability through GitHub's [private vulnerability reporting](https://github.com/tycoworks/tycostream/security/advisories/new), not in a public issue. Include the version you're running and how to reproduce the problem. Fixes go into the next release.

tycostream has no [authentication](https://github.com/tycoworks/tycostream/issues/36) yet, so anyone who can reach its port can read every source in `schema.yaml`. That's a known limitation, not a vulnerability, so serve it only on a network you trust.
