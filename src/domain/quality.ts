export type ValidationSeverity = 'error' | 'warning' | 'suggestion'

export type ValidationIssue = {
  id: string
  severity: ValidationSeverity
  message: string
  remediation: string
  location?: string
}

export type QualityState = 'blocked' | 'needs-attention' | 'ready'

export type QualityResult = {
  state: QualityState
  issues: ValidationIssue[]
}

type ParsedSource = {
  frontmatter: Map<string, string | string[]>
  body: string
  issues: ValidationIssue[]
}

const issue = (
  id: string,
  severity: ValidationSeverity,
  message: string,
  remediation: string,
  location?: string,
): ValidationIssue => ({ id, severity, message, remediation, location })

const unquote = (value: string) => {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) return trimmed.slice(1, -1)
  return trimmed
}

const parseInlineList = (value: string): string[] | null => {
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map(unquote).filter(Boolean)
  }
  return null
}

const parseSource = (content: string): ParsedSource => {
  const normalized = content.replaceAll('\r\n', '\n')
  const issues: ValidationIssue[] = []
  if (!normalized.startsWith('---\n')) {
    issues.push(issue(
      'frontmatter.missing', 'error',
      'The file does not begin with YAML frontmatter.',
      'Add an opening --- line as the first content in the file.',
      'frontmatter',
    ))
    return { frontmatter: new Map(), body: normalized, issues }
  }

  const lines = normalized.split('\n')
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === '---')
  if (closingIndex < 0) {
    issues.push(issue(
      'frontmatter.unclosed', 'error',
      'The YAML frontmatter has no closing delimiter.',
      'Add --- on its own line after the metadata.',
      'frontmatter',
    ))
    return { frontmatter: new Map(), body: '', issues }
  }

  const frontmatter = new Map<string, string | string[]>()
  let listKey: string | null = null
  for (const line of lines.slice(1, closingIndex)) {
    const listItem = line.match(/^\s+-\s+(.+)$/)
    if (listItem && listKey) {
      const current = frontmatter.get(listKey)
      const values = Array.isArray(current) ? current : []
      values.push(unquote(listItem[1]))
      frontmatter.set(listKey, values)
      continue
    }
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (!field) continue
    const [, key, rawValue] = field
    const inlineList = parseInlineList(rawValue)
    if (inlineList) {
      frontmatter.set(key, inlineList)
      listKey = null
    } else if (!rawValue.trim()) {
      frontmatter.set(key, [])
      listKey = key
    } else {
      frontmatter.set(key, unquote(rawValue))
      listKey = null
    }
  }
  return { frontmatter, body: lines.slice(closingIndex + 1).join('\n').trim(), issues }
}

const fieldText = (frontmatter: Map<string, string | string[]>, key: string) => {
  const value = frontmatter.get(key)
  return Array.isArray(value) ? value.join(', ') : (value ?? '')
}

const fieldList = (frontmatter: Map<string, string | string[]>, key: string) => {
  const value = frontmatter.get(key)
  if (Array.isArray(value)) return value
  if (!value) return []
  return value.split(',').map(part => part.trim()).filter(Boolean)
}

const hasProcess = (body: string) =>
  /^##?\s+(process|instructions|workflow|steps|method)\b/im.test(body) ||
  (body.match(/^\s*\d+[.)]\s+/gm)?.length ?? 0) >= 2

const hasOutputContract = (body: string) =>
  /^##?\s+(output|result|response|format|deliverable)s?\b/im.test(body)

const hasConstraints = (body: string) =>
  /^##?\s+(constraints|boundaries|safeguards|limitations|failure|escalation)\b/im.test(body) ||
  /\b(do not|must not|never|escalate|stop and ask)\b/i.test(body)

export function evaluateSource(
  kind: 'skill' | 'agent',
  content: string,
  knownSkillNames: string[] = [],
): QualityResult {
  const parsed = parseSource(content)
  const issues = [...parsed.issues]
  const { frontmatter, body } = parsed
  const name = fieldText(frontmatter, 'name').trim()
  const description = fieldText(frontmatter, 'description').trim()

  if (!name) issues.push(issue(
    `${kind}.name.missing`, 'error',
    `The ${kind} has no name.`,
    `Add a unique name to the ${kind} frontmatter.`,
    'frontmatter.name',
  ))
  if (!description) issues.push(issue(
    `${kind}.description.missing`, 'error',
    `The ${kind} has no description.`,
    `Explain what the ${kind} does and when it should be used.`,
    'frontmatter.description',
  ))
  if (!body) issues.push(issue(
    'body.empty', 'error',
    'There are no instructions after the frontmatter.',
    'Add clear operational instructions.',
    'body',
  ))
  if (/\b(TODO|TBD|replace me|describe (when|how|the))\b/i.test(body)) issues.push(issue(
    'body.placeholder', 'warning',
    'The instructions still contain starter placeholder text.',
    'Replace placeholders with specific, executable guidance.',
    'body',
  ))
  if (body && body.length < 120) issues.push(issue(
    'body.too-brief', 'warning',
    'The instruction body is very brief.',
    'Add activation context, process, constraints, and expected output.',
    'body',
  ))

  const activationText = `${description}\n${body}`
  if (!/\b(use (this )?(skill|agent) when|when (the user|asked|a request)|trigger|delegate|requests? (that|to|for))\b/i.test(activationText)) {
    issues.push(issue(
      `${kind}.activation.unspecified`, 'warning',
      'Activation conditions are not explicit.',
      `State the requests or situations that should activate this ${kind}.`,
      description ? 'frontmatter.description' : 'body',
    ))
  }
  if (body && !hasProcess(body)) issues.push(issue(
    `${kind}.process.missing`, 'warning',
    'No repeatable process was detected.',
    'Add a Process or Instructions section with ordered steps.',
    'body',
  ))
  if (body && !hasOutputContract(body)) issues.push(issue(
    `${kind}.output.missing`, 'warning',
    'No output contract was detected.',
    'Specify the expected result, response structure, and quality bar.',
    'body',
  ))
  if (body && !hasConstraints(body)) issues.push(issue(
    `${kind}.constraints.missing`, 'warning',
    'No constraints or escalation guidance were detected.',
    'Document important boundaries and when to stop or ask for help.',
    'body',
  ))

  if (kind === 'agent') {
    if (name && (name.startsWith('-') || name.includes(':') || name.length > 256)) issues.push(issue(
      'agent.name.invalid', 'error',
      'The agent name is not valid for Claude Code.',
      'Use at most 256 characters and do not begin with - or include :.',
      'frontmatter.name',
    ))
    const model = fieldText(frontmatter, 'model').trim()
    const aliases = new Set(['inherit', 'sonnet', 'opus', 'haiku', 'fable'])
    if (model && !aliases.has(model) && !/^claude-[a-z0-9._-]+$/i.test(model)) issues.push(issue(
      'agent.model.unsupported', 'error',
      `The model “${model}” is not a recognized Claude model value.`,
      'Choose inherit, sonnet, opus, haiku, fable, or a full Claude model ID.',
      'frontmatter.model',
    ))
    if (body && !/(^|\n)#{1,3}\s+(role|objective|purpose)\b|\byou are\b|\byour role\b/i.test(body)) issues.push(issue(
      'agent.role.missing', 'warning',
      'The agent has no clearly stated role or objective.',
      'State the specialist role and the outcome it owns.',
      'body',
    ))
    const known = new Set(knownSkillNames.map(value => value.toLowerCase()))
    for (const skill of fieldList(frontmatter, 'skills')) {
      if (known.size && !known.has(skill.toLowerCase())) issues.push(issue(
        'agent.skill.missing', 'warning',
        `The assigned skill “${skill}” was not found in this library.`,
        'Select an existing skill, install it, or remove the reference.',
        'frontmatter.skills',
      ))
    }
  }

  const state: QualityState = issues.some(finding => finding.severity === 'error')
    ? 'blocked'
    : issues.some(finding => finding.severity === 'warning')
      ? 'needs-attention'
      : 'ready'
  return { state, issues }
}
