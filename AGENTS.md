# Agent guidelines

Read `CLAUDE.md` first for the project overview, workspace boundaries, code
style, and test commands. This file describes how to work with me.

These rules are short by design. Follow them literally.

## Before you act

- Inspect the relevant files and existing changes before editing.
- Read any report or handoff connected to the task. A parked state may be
  intentional.
- Separate what I asked you to do from defects or improvements you notice.
- If the request is ambiguous and a wrong assumption would create rework, ask
  one short question.

## Do not change code unless asked

An observation is not a request. “I saw X” means explain X; it does not mean
fix X. Report what you found, say what you would change and why, then wait for
permission.

This applies to code, tests, fixtures, development files, configuration,
documentation, and generated files. Finding a real defect while doing another
task does not authorize fixing it.

Do not overwrite, revert, or reorganize existing work unless I explicitly ask.

## Stay in scope

Make the smallest change that satisfies the request. Do not add opportunistic
refactors, cleanup, dependency updates, or unrelated test changes. Do not
restructure intentionally parked work.

If another change is required for the requested change to work, explain the
dependency rather than silently expanding the task.

## Be brief and concrete

Give the shortest answer that fully answers the question. Do not restate my
request or repeat a summary.

I am not a web developer. Use ordinary language, define jargon the first time,
and prefer a concrete example to an abstract explanation.

## Give exact commands

Give each command on one line. Never provide a multi-line script for me to
paste into a browser console or terminal.

For every command, briefly state:

- what success looks like;
- what failure looks like; and
- any required directory, process, reload, or restart.

## Do not assume my workflow or state

Do not assume I ran earlier steps, stayed in the same session, reloaded a page,
or restarted a process. Ask, or make each instruction explicit enough to work
from the state I actually reported.

When I give you results, reason from what I actually did—not from the sequence
you expected me to follow.

## Cite documents precisely

Name the file and its section, for example `report.md` §“Observed results”. If
you refer to a table, name the table. Do not make me hunt through a document or
use a bare section number such as “§12.9”.

## Treat visible behavior as evidence

I look at the screen; you may inspect the DOM, logs, or counters. When those
disagree, neither observation is automatically wrong. First check whether the
measurement observes the same thing, at the same time, and in the same units.

For example, a counter named “blank passes” returning zero while blanks are
visible suggests a measurement or naming problem; it does not prove the screen
observation is wrong.

## Distinguish facts from explanations

Clearly label:

- **Measured:** directly observed in a named run, log, screenshot, or test.
- **Consistent with:** a plausible explanation that the evidence supports but
  does not prove.
- **Unverified:** not checked.
- **Deferred:** intentionally left unresolved.

When a hypothesis fails, say so and keep that result in the record. When your
instrument was wrong, lead with that. Do not quietly discard contrary evidence
or turn unverified work green.

## Instrument before guessing

If a bug survives one fix attempt, measure it before proposing another theory.
Validate the instrument before trusting its output:

- Does it observe the behavior at the right time?
- Can it distinguish the competing cases?
- Are its name and units accurate?

State how to interpret the result before asking me to run the test.

## Show evidence for verification claims

“Verified” means you ran the named check and saw it pass. Report the exact check
and result. If you did not run it, say “not run”.

If you say a test covers a fix, show that it fails without the fix and passes
with it. If you report a number, identify the run that produced it. Do not
present a plausible explanation as a finding.

## When in doubt, ask

A short question costs me ten seconds. An unrequested change costs me a review,
a revert, and trust.
