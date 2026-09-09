<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Contributing

Thanks for looking. This project moves real advertising money, so the bar for changes
in the write path is higher than in a typical library — please read the short version
below before opening a pull request.

## Setup

```bash
npm ci
npm run build
npm test
```

Node ≥ 22.13 is required (`node:sqlite`). No Google credentials are needed to run the
test suite — every test uses an injected fake context or a local server with dummy
credentials, and nothing reaches Google.

## Ground rules for the write path

Anything that can create, modify, enable or otherwise increase spend must keep these
properties. If your change touches them, say so explicitly in the PR description.

1. **Campaigns are created paused.** No code path may create a serving campaign.
2. **Spend increases require human approval**, obtained through `approval.ts` — not by
   trusting a flag the agent set.
3. **Ambiguity fails closed.** If you can't establish that an action is safe, ask.
   Returning early "because the query came back empty" is the exact bug class this
   project has already been bitten by.
4. **The agent cannot widen its own limits.** Budget ceiling and write permission stay
   readable over MCP and writable only from a human session.

## Tests

Every change to a guard needs a test, and the test needs to actually fail when the guard
is removed. Verify that yourself:

```bash
# 1. break the guard on purpose
# 2. npm test  → the relevant test must go red
# 3. restore the guard
# 4. npm test  → green again
```

This is not ceremony. Two defects in this repository's history were found exactly this
way: a fix that existed only in a commit message, and a test that asserted on a value
the code never produced. A green suite is not evidence that the suite works.

Where to put things:

| Kind of test | File |
|---|---|
| Pure helpers | `test/util.test.ts`, `test/rateLimit.test.ts`, `test/siteExtract.test.ts` |
| Tool behaviour over MCP | `test/tools.read.test.ts`, `test/tools.write.test.ts` |
| Approval / elicitation | `test/approval.test.ts` |
| Network trust gate, link by link | `test/networkTrust.test.ts`, `test/networkTrustHalkalar.test.ts`, `test/networkTrustNv.test.ts`, `test/networkTrustSim.test.ts` |
| What the gate puts on the wire, and what it makes of the answer | `test/nacIstek.test.ts`, `test/nacIstemci.test.ts`, `test/bozukYanit.test.ts` |
| Which tools the gate covers, which links a risk tier runs, where step-up stops | `test/kapiKapsami.test.ts`, `test/riskEslemesi.test.ts`, `test/kademeliDogrulama.test.ts` |
| The chain registry against its downstream consumers | `test/zincirButunlugu.test.ts`, `test/zincirBelgeKademe.test.ts`, `test/camaraBelge.test.ts` |
| HTTP, auth, sessions | `test/http.test.ts` |
| Fail-closed regressions | `test/failclosed.test.ts` |
| Adversarial scenarios | `test/eval.test.ts` |
| Documented guarantees | `test/promises.test.ts` |

If you add a promise to the README, the resource `limits` rules, or a tool description,
add the matching test to `test/promises.test.ts`. Documentation that drifts from
behaviour is a silent failure — the user trusts what's written.

A new link in the trust chain is not finished when its own layer is green. Declare it in
`ZINCIR_HALKALARI` (`src/networkTrust.ts`), the chain's single registry, and
`test/zincirButunlugu.test.ts` will hold every downstream consumer against it: the decision
log's field, the `contextFor` cache key in `http.ts`, Growth Brain's refusal classifier, the
environment documentation. That connection went missing four rounds running, and it went
missing silently every time — the gate itself kept working. If the link ever runs against a
live endpoint, put the date in its `canliDogrulandi`: the liveness claims in `docs/CAMARA.md`
and both READMEs are derived from that field, not from the prose around it.

## Code style

- TypeScript, ES modules, no build tooling beyond `tsc`.
- `npm run typecheck` must pass; it includes tests and `noUnusedLocals`. An unused
  import usually means something was added but never wired up.
- Comments should state constraints the code can't express — *why* a guard exists, what
  breaks without it, which API behaviour forced an odd shape. Don't narrate history
  ("this used to be…", "found during review"); the next reader needs the rule, not the
  changelog.
- Agent-facing strings (tool descriptions, prompts, error messages) are Turkish and
  should stay consistent with the existing voice. Code, comments and docs are English.

## Tool descriptions

An MCP server's quality is largely how reliably a model picks the right tool. When
adding or changing one, keep the shape:

> what it does · **KULLAN:** when to reach for it · **KULLANMA:** when not to, and which
> tool instead · **GÜVENLİK/DİKKAT:** the trap

Cross-reference tools that are easy to confuse — `keyword_performance` and
`search_terms_report` point at each other for exactly this reason.

## Security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md) for the private
reporting route and the invariants that count as in-scope.

## Licensing

By contributing you agree your work is licensed under **AGPL-3.0-only**. New source
files need the SPDX header:

```ts
// SPDX-License-Identifier: AGPL-3.0-only
```

If you deploy a modified version as a network service, AGPL §13 obliges you to offer
its source to that service's users — set `AEGIS_SOURCE_URL` to your own repository.

## Commit messages

History follows [Conventional Commits](https://www.conventionalcommits.org/): a type, an
optional scope naming the subsystem, and an imperative subject that fits in 72 characters.

    feat(trust-gate): add reachability and roaming links to the chain
    fix(brain): treat EOF on an approval prompt as refusal
    test: require every spend-increasing tool to be gate-covered

Types in use: `feat`, `fix`, `test`, `docs`, `chore`. Scopes in use: `trust-gate`, `brain`,
`meta`, `demo`.

The body matters more than the subject. State *why*, not what the diff already shows — the
constraint you were working against, the alternative you rejected, the trap that cost you
an afternoon. Several guards in this repository exist because a body explained a
non-obvious hazard; a subject alone would not have carried it.

If a change touches the spending path, say in the body how you verified it and what you
did not verify. "Not exercised live" is a legitimate and useful thing for a commit to say.
