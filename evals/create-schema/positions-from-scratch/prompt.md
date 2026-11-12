---
tags: [skill-creator]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

I've got Materialize running locally on port 6878 (user and password are both materialize, database positions_app) with my trading desk's views. I want to serve the positions view and the trades table through tycostream, so the UI can show each position with its trades. Can you write the schema.yaml? I'm away for a bit, so don't wait on me to confirm anything: use your best judgment and tell me what you assumed.
