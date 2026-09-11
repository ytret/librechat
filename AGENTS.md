Read CLAUDE.md for an overview of this project, this file contains guidelines
for AI agents.

# How I expect an agent to work in this repo

Short by design. These are the behaviours I asked for, mostly after correcting
an agent that didn't do them.

## Do not change code unless asked

An observation is not a request. "I saw X" means *tell me about X*, not *go fix
X*. Report the finding, say what you would change and why, and **wait**. This
includes tests, fixtures, dev-only files, and config. If you find a real defect
while investigating something else, describe it and ask — finding it does not
authorise fixing it.

## Be brief

Short answers. No essays, no restating what I just told you, no summary of your
own summary. If a question has a one-line answer, give one line. If you need to
explain a mechanism, explain it in plain terms and stop.

I'm not a web developer. Use ordinary language, define jargon the first time,
and prefer a concrete example over an abstract description.

## Give me exact commands, one line each

Never multi-line scripts — they get mangled in a browser console. One paste,
one command. Tell me what to expect from each, and what a failure looks like so
I can tell the difference.

## Don't assume my workflow

Ask, or write the instructions so any sane order works. Don't assume I did the
steps in one continuous session, don't assume I reloaded when you didn't say
to, and don't assume the state I'm in. When I report results, work from what I
actually did.

## Name the document and section

Cite `file.md` §N — not "§12.9". If it's a table, say which table. Never make
me hunt for a reference.

## My eyes beat your counters

I look at the screen; you read the DOM. When they disagree, neither is lying —
your measurement is probably measuring something other than what I'm looking
at. Say that instead of picking a side. A counter named "blank passes"
returning 0 while I watch blanks is a naming/units problem, not proof I'm
wrong.

## Say what you know, what you don't, and what you got wrong

- Record deferred or unverified things as deferred or unverified. Don't round
  up to green.
- When a hypothesis dies, say so and keep it in the record. Don't quietly drop
  it.
- When your own instrument was wrong, lead with that. Both times it happened
  here, it had already produced plausible-looking numbers.
- Distinguish "measured" from "consistent with". Don't present a good story as
  a finding.

## Instrument before guessing, then check the instrument

Once a bug survives one fix attempt, measure it rather than theorising. But
validate the measurement before trusting it: does it observe the thing at the
right time, and can it tell the two cases apart? State the rule you'd use to
read the result *before* handing me the test.

## Show the evidence, not the claim

If you say a test covers a fix, show that it fails without the fix. If you say
a number, give the run that produced it. "Verified by X" means you ran X.

## Stay in scope

Do not expand the task. No opportunistic refactors, no collateral cleanups, no
unrequested "while I was in there" changes. Do not revert or restructure things
that are intentionally parked — the parked state is usually documented, so read
the report before touching it.

## When in doubt, ask

A short question costs me ten seconds. An unrequested change costs me a review,
a revert, and trust.
Short by design. These are the behaviours I asked for, mostly after correcting
an agent that didn't do them.

## Do not change code unless asked

An observation is not a request. "I saw X" means *tell me about X*, not *go fix
X*. Report the finding, say what you would change and why, and **wait**. This
includes tests, fixtures, dev-only files, and config. If you find a real defect
while investigating something else, describe it and ask — finding it does not
authorise fixing it.

## Be brief

Short answers. No essays, no restating what I just told you, no summary of your
own summary. If a question has a one-line answer, give one line. If you need to
explain a mechanism, explain it in plain terms and stop.

I'm not a web developer. Use ordinary language, define jargon the first time,
and prefer a concrete example over an abstract description.

## Give me exact commands, one line each

Never multi-line scripts — they get mangled in a browser console. One paste,
one command. Tell me what to expect from each, and what a failure looks like so
I can tell the difference.

## Don't assume my workflow

Ask, or write the instructions so any sane order works. Don't assume I did the
steps in one continuous session, don't assume I reloaded when you didn't say
to, and don't assume the state I'm in. When I report results, work from what I
actually did.

## Name the document and section

Cite `file.md` §N — not "§12.9". If it's a table, say which table. Never make
me hunt for a reference.

## My eyes beat your counters

I look at the screen; you read the DOM. When they disagree, neither is lying —
your measurement is probably measuring something other than what I'm looking
at. Say that instead of picking a side. A counter named "blank passes"
returning 0 while I watch blanks is a naming/units problem, not proof I'm
wrong.

## Say what you know, what you don't, and what you got wrong

- Record deferred or unverified things as deferred or unverified. Don't round
  up to green.
- When a hypothesis dies, say so and keep it in the record. Don't quietly drop
  it.
- When your own instrument was wrong, lead with that. Both times it happened
  here, it had already produced plausible-looking numbers.
- Distinguish "measured" from "consistent with". Don't present a good story as
  a finding.

## Instrument before guessing, then check the instrument

Once a bug survives one fix attempt, measure it rather than theorising. But
validate the measurement before trusting it: does it observe the thing at the
right time, and can it tell the two cases apart? State the rule you'd use to
read the result *before* handing me the test.

## Show the evidence, not the claim

If you say a test covers a fix, show that it fails without the fix. If you say
a number, give the run that produced it. "Verified by X" means you ran X.

## Stay in scope

Do not expand the task. No opportunistic refactors, no collateral cleanups, no
unrequested "while I was in there" changes. Do not revert or restructure things
that are intentionally parked — the parked state is usually documented, so read
the report before touching it.

## When in doubt, ask

A short question costs me ten seconds. An unrequested change costs me a review,
a revert, and trust.
