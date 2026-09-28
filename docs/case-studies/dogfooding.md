# The first audit: pointing gateINITIATIVE at itself

September 2026. Before public release. Every bug below was found and fixed in one session, test-first.

The README says gateINITIATIVE can patrol any repo. So before starting the next phase I wanted to actually try that on the one repo that matters most — its own. What better place to dogfood a tool than the repo it lives in? Turn on my own preset gates, add my own fixtures, run my own verification commands, see what it catches. It failed five times before it passed. Honestly I expected it to fail some. I did not expect this.

| | |
|---|---|
| Real bugs found | 5, plus 1 minor |
| Found by | the tool's own output, every one |
| Gates activated | 2 (`no-deep-relative-imports`, `test-integrity-guard`) |
| Fixtures added | 12 — pass and fail for all six active gates |
| Final state | 310 tests green, `check` clean on 67 files, 12 of 12 fixtures |

## Why I did it

I was about to start the observability phase and asked a preflight question: does my workflow actually cover modular design, paradigms, and testing? Testing, yes — that's a habit already. The other two, not really. But gateINITIATIVE ships both as onboarding presets, so the obvious move was to turn my own presets on myself. I skipped `no-classes-in-src` on purpose — this codebase uses classes for stateful services by design, and a gate that fights the architecture it patrols is just noise.

One embarrassing thing up front: at that point the repo had zero pass/fail fixtures for any gate, even though my own written rule says a gate is only trustworthy when its fixtures behave. So before anything else I had 12 fixtures written covering every active gate. That step ended up mattering more than I expected.

## Finding 1: the tool wrote a file its own reader couldn't parse

The first round-trip test I asked for takes the YAML `renderGatesYml` generates and feeds it back through `extractGatesFromYaml`. It found zero gates. I stared at that for a while — the file looked fine. Eventually I saw it: multi-line trigger lists render unquoted, and a YAML plain scalar starting with `**` is an invalid alias, so the whole generated `onboarded.yml` silently never loaded. Which means every gate anyone ever onboarded — secrets detection included — enforced nothing and reported nothing. I had never once round-tripped the generator's output through its own consumer. Fixed by quoting the list items, plus a regression test that round-trips generated YAML and evaluates the gate for real.

## Finding 2: the test-integrity gate flagged every honest test file

The generated `test-integrity-guard` used `pattern: /^\s*$/m`. In this tool, `pattern` means "violation if found" — so any test file containing a blank line got flagged as an empty test file. Nearly every test file ever written has a blank line. I had the polarity backwards: "file is empty" needs `antipattern: /\S/` — violation if no non-whitespace character exists. Fixing it surfaced a second bug: `renderGatesYml` only knew how to render `pattern`, not `antipattern`, so even the corrected preset would have been silently mis-rendered. Both got fixed.

## Finding 3: the new gate flagged its own documentation

After activating `no-deep-relative-imports`, `gateinit check` reported two violations in code I knew was clean: a `new URL('../../package.json')` version read, and a line inside `docs/agents/modular-design.md` that explains what a deep import is. It took me a minute to accept the tool was wrong and not me. The pattern matched any `../`-shaped text — prose included. I anchored it to real import syntax — `/(from\s*['"]|import\s*\(\s*['"]|require\s*\(\s*['"])(\.\.\/){2,}/` — so only actual static, dynamic, or `require` deep imports match.

## Finding 4: the scanner was scanning its own rule files

The fixture for `no-secrets-in-source` is literally a file containing a fake secret — building it is what surfaced this one. Both the one-shot scanner and the watch daemon were treating `.gates/` — the directory where the rules and fixtures live — as project source. The ignore lists covered `.gateinitiative/` (the runtime dir) but not `.gates/` (the data dir). So the tool would have flagged its own test fixtures as violations forever. Fixed by ignoring `.gates` in `collectFiles` and in the watcher defaults, with a regression test in each place.

## Finding 5: a test that only failed on my own machine

One onboarding test hung for five seconds and timed out on my workstation — while passing in CI. That one was confusing because CI is usually where things break. Turned out `runOnboarding` starts its interactive interview whenever the machine has global AI-assistant instruction files (`~/.claude`, IDE memories). My machine has them; the CI runner doesn't, so the prompt never triggered there and the test sailed through. The fix was passing `yes: true` to skip the interview while still exercising the confirm-abort path the test exists for. "Tests must not prompt on stdin" was already my own written rule. I broke it in my own suite.

## Verification

Every fix landed the same way: a failing test that reproduces the bug, then the smallest fix that turns it green. Final state, all commands run against this repo:

```
bun test src/          -> 310 pass, 0 fail
gateinit check         -> 67 files, 6 gates, 0 violations
gateinit test          -> 12 fixtures, 0 failed
```

## What I'll be honest about

The watch daemon wasn't even running during this. Every bug came from the one-shot commands and from writing behavioral tests for my own presets. You don't need always-on enforcement to catch real bugs — you just have to actually run your own checks on your own output, which apparently I hadn't.

The first two hits from the new gate were false positives, not real violations. The actual bugs were hiding behind them, in the generator, the predicate semantics, and the scanner. I only found them because I refused to ship a gate whose fixtures hadn't passed.

And the process itself: I don't work on this alone. I spec with an AI pair — it gives me a few options, I research in the moment, I pick one, we build it. The tests run the same way: I drive a test-first setup, I decide what needs checking, the tests get written for me — my job is reading what falls out. Most of my "method" is instinct plus that loop, and this session was no different. I'm not going to pretend I foresaw a YAML alias bug. I asked for a test that seemed obvious, it failed weirdly, and I followed where it pointed. Five times.

The full changelog for these fixes is in [CHANGELOG.md](../../CHANGELOG.md) under *Unreleased*.
