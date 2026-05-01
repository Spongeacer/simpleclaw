---
name: code-review
description: Review code for bugs, style issues, security vulnerabilities, and architecture problems
triggers: ["review", "code review", "审代码", "审查", "bug check"]
---

# Code Review

Systematically review code changes and provide actionable feedback.

## Workflow

1. **Understand scope** — What files changed? What is the intended behavior?
2. **Read critically** — Check logic, edge cases, error handling, naming.
3. **Verify** — Look for tests, type safety, and security issues.
4. **Report** — Summarize findings: critical / warning / suggestion.

## Checklist

### Logic & Correctness
- [ ] Does it handle edge cases (empty input, null, overflow)?
- [ ] Are race conditions possible?
- [ ] Is error handling complete?

### Style & Maintainability
- [ ] Naming is clear and consistent with project conventions?
- [ ] Functions are reasonably sized?
- [ ] No dead code or commented-out blocks?

### Security
- [ ] No hardcoded secrets or credentials?
- [ ] User input is validated/sanitized?
- [ ] No unsafe eval or injection risks?

### Tests
- [ ] New behavior has test coverage?
- [ ] Existing tests still pass?

## Output Format

```
## Summary
[1-sentence overall assessment]

## Critical
- [file:line] [issue] → [suggested fix]

## Warnings
- [file:line] [issue] → [suggestion]

## Suggestions
- [file:line] [improvement idea]
```
