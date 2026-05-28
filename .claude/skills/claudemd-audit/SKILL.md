---
name: claudemd-audit
description: Audit CLAUDE.md system design maturity — evaluates layering, pattern usage, cross-system coherence, and identifies missed optimization opportunities. For advanced Claude Code users who want to level up their configuration.
argument-hint: "[path-to-project]"
allowed-tools: Read, Bash, Grep, Glob
---

# CLAUDE.md System Design Audit

This is not a linter. It evaluates whether your CLAUDE.md system leverages the design patterns that actually matter for multi-project professionals, and identifies gaps that will cause real problems.

## Design Patterns Checklist (6 Patterns)

Tier 1 (everyone must have): Anti-Pattern Suppression, Trust Boundaries, Execution Routing
Tier 2 (multi-project environments): Subagent Discovery, Self-Maintaining Structures, Lazy-Load Reference

Audit against these patterns. For each: detect presence → evaluate quality → report gaps.

---

### Pattern 1: Lazy-Load Reference Architecture

**What**: Instead of stuffing all reference content into CLAUDE.md (bloating context window every turn), maintain a pointer table with explicit trigger conditions. Content loads only when the scenario matches.

**Detection**:
- Look for tables or lists linking to external `.md` files with trigger conditions
- Check: do trigger descriptions match actual file content?
- Check: are referenced files actually present on disk?

**Quality signals**:
- Good: Triggers are specific and falsifiable ("before selecting AWS service versions" not "when needed")
- Good: Files are modular — one concern per file, <500 lines each
- Bad: Trigger conditions overlap (two files load for same scenario)
- Bad: Pointer exists but file hasn't been updated in months while codebase changed
- Missing: A frequently-consulted topic has no reference file (user re-explains it every session)

---

### Pattern 2: Anti-Pattern Suppression

**What**: Rules that specifically target known Claude behavioral tendencies — filler generation, unsolicited analysis, over-helpfulness, silent failures. These are adversarial constraints against the model's own biases.

**Detection**:
- Look for explicit prohibitions: "never", "do not", "must not", "forbidden"
- Categorize: which Claude failure mode does each rule suppress?

**Known Claude failure modes worth suppressing**:
| Failure Mode | Example Suppression Rule |
|---|---|
| Filler content | "Do not pad comparison tables with weak options" |
| Over-autonomy | "Ask before batch-modifying 3+ files" |
| Silent failure | "Report errors after 2nd failed retry, do not keep trying silently" |
| Scope creep | "Do not refactor beyond what the task requires" |
| Hallucinated certainty | "Must search for post-cutoff information, never assume from training data" |
| Unsolicited commentary | "Do not add 'limitations' or 'takeaway' sections unless requested" |

**Quality signals**:
- Good: Each suppression targets a specific, experienced failure (not hypothetical)
- Good: Rule is actionable — Claude can self-check compliance
- Bad: Rule is vague ("be careful") — unenforceable
- Bad: Important failure mode remains unsuppressed (user keeps correcting the same behavior)
- Missing: No retry/escalation protocol for when Claude hits a wall

---

### Pattern 4: Conditional Trust Boundaries

**What**: Not all operations are equal. Define perimeters where certain actions are pre-approved vs require confirmation, based on context (account, environment, file path, operation type).

**Detection**:
- Look for conditional permission structures: "for X, execute directly; for Y, confirm first"
- Check settings.json allow/deny lists for corresponding enforcement
- Check: does the boundary match actual risk?

**Quality signals**:
- Good: Trust boundary maps to real blast radius (prod vs dev, known account vs unknown)
- Good: Boundary is enforced in both CLAUDE.md AND settings.json/hooks (dual-layer)
- Bad: Trust boundary only declared in CLAUDE.md (unenforced — Claude may forget under context pressure)
- Bad: Overly permissive or overly restrictive with no gradation
- Missing: High-risk operations (cloud writes, git push, dependency changes) have no trust boundary

---

### Pattern 5: Self-Maintaining Structures

**What**: Data sections within CLAUDE.md that include their own maintenance rules, so they stay current as part of normal workflow rather than rotting silently.

**Detection**:
- Look for data (tables, indexes, lists) paired with update triggers ("when creating X, must also update Y")
- Check: is the maintenance rule placed adjacent to the data it governs?

**Quality signals**:
- Good: Trigger fires as part of natural workflow (creating a directory triggers index update)
- Good: Maintenance rule is simple enough to follow without breaking flow
- Bad: Data section exists without maintenance rule (will rot within weeks)
- Bad: Maintenance rule is complex or requires multi-step verification (will be skipped)
- Missing: Frequently-changing information has no self-update mechanism

---

### Pattern 6: Execution Routing

**What**: Decision logic for WHERE and HOW operations execute — local vs remote, which tool to use, which agent/subagent handles it.

**Detection**:
- Look for routing rules with explicit predicates and dispatch logic
- Check: are predicates mutually exclusive? Is there a default path?

**Quality signals**:
- Good: Predicates are evaluable at decision time (not "if it seems complex")
- Good: Default path exists for unmatched cases
- Bad: Routing conditions overlap — two paths could match the same scenario
- Bad: No routing exists but user operates across multiple execution contexts (local, cloud, CI)
- Missing: Long-running tasks always run locally when remote dispatch would free the session

---

### Pattern 7: Subagent Discovery Protocol

**What**: Rules governing how agents/subagents discover and respect local configuration when traversing directory boundaries.

**Detection**:
- Look for "before entering X, check for..." patterns
- Check: does the rule cover all boundary-crossing scenarios?

**Quality signals**:
- Good: Explicit protocol for multi-repo or monorepo environments
- Good: Defines what to inherit from parent vs what to discover fresh at target
- Bad: Subagents operate in subdirectories without checking for local CLAUDE.md overrides
- Missing: Project has subdirectories with different conventions but no cascade protocol

---

## Audit Procedure

### Step 1: Discover System Boundaries

```bash
# Global layer
cat ~/.claude/CLAUDE.md

# Project layer
find "$PROJECT_ROOT" -name "CLAUDE.md" -not -path "*/node_modules/*" -not -path "*/.git/*"

# Enforcement layer
cat ~/.claude/settings.json
find "$PROJECT_ROOT" -path "*/.claude/settings.json"

# Memory layer
cat ~/.claude/projects/*/memory/MEMORY.md

# Skills layer
ls ~/.claude/skills/
ls "$PROJECT_ROOT/.claude/skills/" 2>/dev/null
```

### Step 2: Score Each Pattern

For each of the 6 patterns:
- **Present & Well-Implemented** (2 pts): Pattern is used and quality signals are positive
- **Present but Weak** (1 pt): Pattern exists but has quality issues
- **Absent** (0 pts): Pattern not used where it would add value
- **N/A**: Pattern doesn't apply to this user's workflow

### Step 3: Generate Report

```markdown
# CLAUDE.md Design Audit

## Score: X/12

## Pattern Assessment

### [check] Pattern 2: Anti-Pattern Suppression (2/2)
- Targets 4 specific Claude failure modes with actionable rules
- Each rule is self-checkable

### [warning] Pattern 4: Trust Boundaries (1/2)  
- Account-level boundary well-defined
- BUT: no environment-level boundary (prod/staging/dev treated same)
- Recommendation: add environment context check before destructive ops

### [missing] Pattern 7: Subagent Discovery (0/2)
- Project has 5 subdirectory repos but no cascade protocol
- Subagents entering subdirs may miss local conventions
- Recommendation: add discovery rule in project CLAUDE.md

## Top 3 Opportunities
1. [Highest impact gap with specific fix]
2. ...
3. ...
```

## Judgment Principles

1. **Presence alone scores 0** — A pattern must be well-implemented to score. A pointer table with vague triggers is worse than no table (false sense of coverage).
2. **Context matters** — A developer managing 50+ projects needs all 6 patterns; someone with 3 projects may only need Tier 1.
3. **Anti-patterns have anti-anti-patterns** — Suppression rules that are too aggressive create their own problems (over-cautious Claude that asks permission for everything). Trust boundaries that are too restrictive slow you down more than they protect you.
