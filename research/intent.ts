const MAX_QUESTION_CHARS = 1_200;
const PREFIXES: RegExp[] = [
  /^(?:please\s+)?(?:jarvis,?\s+)?(?:can|could|would)\s+you\s+(?:please\s+)?(?:research|investigate|look into)\b\s*(.*)$/i,
  /^(?:please\s+)?(?:jarvis,?\s+)?(?:research|investigate|look into)\b\s*(.*)$/i,
  /^(?:please\s+)?(?:jarvis,?\s+)?(?:can|could|would)\s+you\s+(?:please\s+)?search\s+(?:the\s+)?(?:web|internet|online)\s+(?:for\s+)?(.*)$/i,
  /^(?:please\s+)?(?:jarvis,?\s+)?search\s+(?:the\s+)?(?:web|internet|online)\s+(?:for\s+)?(.*)$/i,
  /^(?:please\s+)?(?:jarvis,?\s+)?look\s+up\s+online\s+(.*)$/i,
  /^(?:please\s+)?(?:jarvis,?\s+)?find\s+(?:the\s+)?official\s+documentation\s+for\s+(.*)$/i,
  /^(?:please\s+)?(?:jarvis,?\s+)?find\s+current\s+information\s+on\s+(.*)$/i,
  /^(?:please\s+)?(?:jarvis,?\s+)?check\s+(?:whether|if)\s+(.{1,1200})$/i,
  /^(?:please\s+)?(?:jarvis,?\s+)?compare\s+(.{1,1200})$/i,
  /^(?:please\s+)?(?:jarvis,?\s+)?verify\s+(?:whether|if)\s+(.{1,1200})$/i,
];

export type ParsedResearchIntent = { kind: 'research'; question: string } | { kind: 'clarify' } | null;

export function parseResearchIntent(raw: string): ParsedResearchIntent {
  const text = String(raw || '').trim().replace(/[.!?,;:]+$/, '').trim();
  for (const prefix of PREFIXES) {
    const match = text.match(prefix);
    if (!match) continue;
    const question = (match[1] || '').trim().replace(/\s+/g, ' ');
    // Speech recognition can mark a phrase final while the speaker is still
    // forming the request. Trailing function words are a strong, cheap signal
    // that the transcript is syntactically incomplete; ask rather than search.
    if (question.length < 8 || /\b(?:a|an|the|and|or|but|to|of|for|with|about|from|on|in|if|whether|what|which|who|where|when|why|how|current|latest|official)$/i.test(question)) return { kind: 'clarify' };
    if (question.length > MAX_QUESTION_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(question)) return { kind: 'clarify' };
    return { kind: 'research', question };
  }
  return null;
}
