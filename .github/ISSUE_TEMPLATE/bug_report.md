---
name: Bug report
about: Something behaves differently from what the documentation promises
title: ''
labels: bug
assignees: ''
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

**Never paste credentials.** Not a Google Ads refresh token, not a Network-as-Code key, not
a Meta access token, not an approver phone number. If an error message contains one, redact
it before pasting — and please open a security advisory instead of an issue, because a
message that leaks a secret is itself the bug (see [SECURITY.md](../../SECURITY.md)).

## What happened

<!-- The observed behaviour. Exact error text helps, once redacted. -->

## What you expected

<!-- And where that expectation comes from — a README line, a tool description, a doc. If
     the code is right and the documentation is wrong, that is still a bug worth filing. -->

## Steps to reproduce

1.
2.
3.

## Environment

- Aegis version / commit:
- Node version (`node -v`):
- Mode: stdio (`npm start`) / hosted (`npm run serve`) / Docker
- MCP client:

## Trust chain, if the network gate is involved

- Which links are enabled (`AEGIS_*_CHECK`), and which are simulated (`AEGIS_*_SIMULATE`)?
- Decision-log line if you have one (`AEGIS_DECISION_LOG`) — it contains no secrets by
  design, only a masked number and a fixed reason code

## Anything else

<!-- Whether spend was affected. If a guard let something through that it should have
     refused, say so first: that outranks everything else in this template. -->
