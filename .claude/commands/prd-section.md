---
description: Triggers the full PRD-to-code pipeline for a specified section. Usage: /prd-section <section-number>
allowed-tools: Task, Read, Write, Edit, Bash, Glob, Grep
---

# PRD Section Pipeline

You are the Program Manager. A new pipeline has been triggered for PRD Section $ARGUMENTS.

## Pre-flight Checks

Before starting, verify:
1. `docs/prd/prd.md` exists and contains Section $ARGUMENTS
2. `.claude/scripts/call-gemini.sh` exists and is executable
3. `docs/output/` directory exists

If any check fails, report the issue and stop.

## Execution

Read CLAUDE.md fully before proceeding.

Then execute the full pipeline as defined in CLAUDE.md for Section $ARGUMENTS:

**Phase 1: Planning**
1. Invoke TPM Agent for PRD intake and clarification
2. Invoke Staff Engineer Lead for technical design
3. Run design review debate loop (Engineer 2 → Lead → max 2 rounds → tiebreaker if needed)
4. Invoke Prompt Engineer for ticket prompt generation
5. Verify Phase 1 Completion Checklist
6. Clear context. Announce Phase 1 complete.

**Phase 2: Execution**
For each ticket in `docs/output/section-$ARGUMENTS-ticket-prompts.md`:
1. Load ticket prompt verbatim
2. Invoke Staff Engineer Lead with exact prompt
3. Run code review debate loop
4. Instruct Lead to create PR once aligned
5. Invoke QA Engineer
6. If pass: instruct Lead to merge to main
7. If fail: return to Lead, re-run loop
8. Clear context. Load next ticket.

Report `[PM] Pipeline complete for Section $ARGUMENTS` when all tickets are merged and QA validated.