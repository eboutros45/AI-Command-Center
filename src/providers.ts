export type Provider = 'ollama' | 'groq' | 'openai'
export type CurrentProvider = Exclude<Provider, 'openai'>

export const providerNames: Record<Provider, string> = { ollama: 'Ollama', groq: 'Groq', openai: 'OpenAI' }
export const groqDefaultModel = 'openai/gpt-oss-120b'
export const modelSettings: Record<CurrentProvider, string> = { ollama: 'knowledgeModel', groq: 'groqModel' }

export function preferredGroqModel() {
  const saved = localStorage.getItem(modelSettings.groq)?.trim()
  return saved && saved !== 'llama-3.3-70b-versatile' ? saved : groqDefaultModel
}
