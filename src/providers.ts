export type Provider = 'ollama' | 'groq' | 'openai'
export type CurrentProvider = Exclude<Provider, 'openai'>

export const providerNames: Record<Provider, string> = { ollama: 'Ollama', groq: 'Groq', openai: 'OpenAI' }
export const groqDefaultModel = 'llama-3.3-70b-versatile'
export const modelSettings: Record<CurrentProvider, string> = { ollama: 'knowledgeModel', groq: 'groqModel' }
