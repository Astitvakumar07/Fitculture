import { supabase } from './supabase';

export async function askCoach(question, history = []) {
  const safeHistory = (Array.isArray(history) ? history : [])
    .filter(message => ['user', 'assistant'].includes(message?.role) && typeof message?.content === 'string')
    .slice(-10)
    .map(message => ({ role: message.role, content: message.content.slice(0, 800) }));
  const { data, error } = await supabase.functions.invoke('ai-coach', { body: { question, history: safeHistory } });
  if (error) {
    let detail = error.message || 'The Edge Function request failed.';
    const status = error.context?.status;
    if (typeof error.context?.clone === 'function') {
      try {
        const body = await error.context.clone().json();
        detail = body?.error?.message || body?.error || body?.message || detail;
      } catch {
        // Keep the SDK error message when the response body is not JSON.
      }
    }
    throw new Error(`${status ? `HTTP ${status}: ` : ''}${detail}`);
  }
  if (!data?.answer || typeof data.answer !== 'string') {
    throw new Error(data?.error || 'The AI Coach function returned no answer.');
  }
  return data.answer;
}
