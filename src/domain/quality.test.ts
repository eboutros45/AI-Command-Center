import { describe, expect, it } from 'vitest'
import { evaluateSource } from './quality'

const completeSkill = `---
name: code-review
description: Use this skill when the user asks for a code review.
---

# Code review

## Process

1. Inspect the changed code.
2. Prioritize concrete findings.

## Constraints

Do not claim an issue without evidence.

## Output

Return prioritized findings and recommended fixes.
`

describe('evaluateSource', () => {
  it('blocks source without frontmatter', () => {
    const result = evaluateSource('skill', '# Instructions')
    expect(result.state).toBe('blocked')
    expect(result.issues.some(issue => issue.id === 'frontmatter.missing')).toBe(true)
  })

  it('marks a complete skill ready', () => {
    expect(evaluateSource('skill', completeSkill)).toEqual({ state: 'ready', issues: [] })
  })

  it('detects placeholders and missing structure', () => {
    const result = evaluateSource('skill', `---\nname: demo\ndescription: Helps.\n---\n\nTODO: describe how this works.`)
    expect(result.state).toBe('needs-attention')
    expect(result.issues.map(issue => issue.id)).toContain('body.placeholder')
    expect(result.issues.map(issue => issue.id)).toContain('skill.output.missing')
  })

  it('rejects an invalid Claude agent name and model', () => {
    const result = evaluateSource('agent', `---\nname: bad:name\ndescription: Use this agent when asked to review code.\nmodel: gpt-4\n---\n\nYou are a reviewer.\n\n## Process\n\n1. Read.\n2. Review.\n\n## Constraints\n\nDo not edit.\n\n## Output\n\nReturn findings.`)
    expect(result.issues.map(issue => issue.id)).toContain('agent.name.invalid')
    expect(result.issues.map(issue => issue.id)).toContain('agent.model.unsupported')
    expect(result.state).toBe('blocked')
  })

  it('warns about unresolved agent skills', () => {
    const result = evaluateSource('agent', `---\nname: reviewer\ndescription: Use this agent when asked to review code.\nmodel: inherit\nskills: [code-review, security-review]\n---\n\nYou are a reviewer.\n\n## Process\n\n1. Inspect.\n2. Report.\n\n## Constraints\n\nDo not edit.\n\n## Output\n\nReturn findings.`, ['code-review'])
    expect(result.issues.filter(issue => issue.id === 'agent.skill.missing')).toHaveLength(1)
    expect(result.issues.find(issue => issue.id === 'agent.skill.missing')?.message).toContain('security-review')
  })

  it('accepts CRLF frontmatter delimiters', () => {
    expect(evaluateSource('skill', completeSkill.replaceAll('\n', '\r\n')).state).toBe('ready')
  })
})
