# Working in this repository

Conventions for any coding agent, in any tool. Claude Code additionally loads
`CLAUDE.md` where one exists; nothing here depends on Claude, and nothing here
should.

## Documentation — four rules

Ratified 2026-08-16. Full record:
`/Volumes/AI-Lab/Projects/gobot/docs/decisions/001-anchored-architecture-notes.md`

1. **Architecture notes live in `docs/architecture/`**, naming the code they
   describe in frontmatter. See this repo's existing note for the shape.
2. **If you change code a note anchors, fix or re-stamp its `reviewed:` date in
   the same change.** `bun run arch:verify` tells you where you stand.
3. **A real architectural decision gets a short record** in `docs/decisions/` —
   decision, alternatives, why, consequences. Superseded, never rewritten.
4. **Never claim documentation is current without naming the check that passed.**

| state | means | effect |
|---|---|---|
| `CURRENT` | anchors resolve, nothing anchored changed since `reviewed` | — |
| `DRIFTED` | anchors resolve, but anchored code moved after review | labelled, never blocks |
| `BROKEN` | a **required** anchor no longer resolves | blocks |

Only `BROKEN` blocks — "does this file exist" is the one check that cannot
misfire, and a gate that misfires once gets switched off forever.

## Where information lives

| Store | Ask it | Do **not** ask it |
|---|---|---|
| `docs/architecture/` | how this works now | history, active work |
| `docs/decisions/` | why we chose it, what we rejected | current state |
| git history | what changed, and retractions | current state |
| The Build Tracking board | what is in flight | anything durable |
| Convex `knowledge` | standing principles and SOPs | how anything works |
| Mimir | what was discussed, and when | current architecture |

The last two were demoted on 2026-08-16 — both were confidently returning a voice
stack deleted three months earlier. They keep the jobs they are good at.

**Contradiction is information.** If a note says one thing and the code plainly
says another, that is an undocumented change nobody recorded — write one line into
the note's `contradiction:` field rather than quietly picking a side.

## Code intelligence

This repo is indexed by GitNexus; `impact`, `trace` and `context` are exact and
worth using before editing an unfamiliar symbol. The index refreshes itself on
every commit, merge and checkout.

**It is a retrieval accelerator, not a source of truth.** It knows the code; it
does not know the system. Config, deployment state, measurements and decisions are
all the system and none of them are the code.

