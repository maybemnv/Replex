---
name: prompt-master
description: Use when a user asks to create, rewrite, optimize, audit, or convert a prompt, system prompt, agent instruction, work order, or reusable instruction set for an AI model or coding/research agent.
---

# Prompt Master

## Principle

Build prompts around real failure modes, not prompt-engineering ceremony. Make success, authority, autonomy, verification, and stopping explicit only when the task needs them. Delete every block that does not reduce a plausible failure.

## Workflow

1. Read the raw request and authoritative user/project instructions first.
2. State the desired end state in one sentence. Sharpen vague outcomes before adding detail.
3. Identify likely failures: wrong context, conflicting instructions, excessive questions, unsafe autonomy, wrong tool choice, unusable output, unverifiable claims, or endless work.
4. Select only the blocks that control those failures.
5. Remove duplicated rules and implementation micromanagement that is not required.
6. Emit the finished prompt. Add only a short note for material assumptions or deliberately omitted blocks.

## Blocks

| Block | Include when |
|---|---|
| `GOAL` | Always; state the end state, not motions. |
| `CONTEXT` | Relevant files, facts, baselines, or examples are non-obvious. |
| `REQUIREMENTS / CONSTRAINTS` | Coverage or boundaries can change correctness. |
| `INSTRUCTION PRIORITY` | Multiple instruction sources may conflict. |
| `AUTONOMY` | The agent can infer, edit, or act without constant approval. |
| `TOOLS / DELEGATION` | Tool choice, parallelism, or permissions matter. |
| `OUTPUT` | Deliverable format, tone, schema, or audience matters. |
| `VERIFICATION` | Code, research, calculations, external facts, or risky work must be checked. |
| `STOP CONDITION` | Agentic or long work needs a crisp definition of done. |

Do not render empty headings. Simple work may need only `GOAL`, `OUTPUT`, and `VERIFICATION`.

## Autonomy

Prefer: “Proceed with reasonable low-risk assumptions; state material assumptions. Ask only when missing information could materially change the result, scope, safety, or an irreversible action.”

Never grant blanket autonomy for destructive, financial, publishing, credential, or production-state changes.

## Verification

Make verification proportional and executable: targeted tests, build/typecheck, source reconciliation, calculations, screenshot inspection, file diff, or artifact probe. Never treat an unrun test list as evidence.

## Stop Condition

Use an observable finish line: named checks pass, required artifacts exist, decision gates are answered, or a specific blocker requires human input. Do not add work merely because more work is possible.

## Anti-Patterns

- Empty roleplay such as “world-class expert.”
- Repeating the same requirement across sections.
- Micromanaging hidden reasoning or every implementation step.
- “Use every tool,” “research exhaustively,” or “run all tests” by default.
- Creating subagents when the work is sequential.
- Vague completion language such as “make sure it is good.”
- Treating confidence as verification.

## Final Gate

Before returning the prompt, verify: clear goal; necessary context; resolved authority conflicts when relevant; bounded autonomy; usable output; executable verification; exact stopping rule. Then remove any section that does not earn its tokens.
