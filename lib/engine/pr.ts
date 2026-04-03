/**
 * PR body generation helpers.
 *
 * buildFallbackPrBody — used when Claude CLI is unavailable.
 * buildClaudePrPrompt — prompt fed to `claude -p` for a rich PR body.
 */

interface FallbackPrBodyOptions {
  message: string;
  actions: Array<{ description: string }>;
  diffStat: string;
}

interface ClaudePrPromptOptions {
  message: string;
  diffStat: string;
  diff: string;
}

/**
 * Build a fallback PR body when Claude CLI is unavailable.
 */
export function buildFallbackPrBody({ message, actions, diffStat }: FallbackPrBodyOptions): string {
  const lines: string[] = [
    '## Summary',
    '',
    message,
  ];

  if (actions?.length > 0) {
    lines.push('', '### 작업 내역');
    for (const a of actions) {
      lines.push(`- ${a.description}`);
    }
  }

  if (diffStat?.trim()) {
    lines.push('', '### 변경된 파일', '```', diffStat.trim(), '```');
  }

  lines.push('', '---', '_🏔 산장에서 보냄_');
  return lines.join('\n');
}

/**
 * Build a prompt for Claude to generate a rich PR body from the diff.
 */
export function buildClaudePrPrompt({ message, diffStat, diff }: ClaudePrPromptOptions): string {
  return [
    'You are writing a GitHub Pull Request description.',
    'The author described the change as: "' + message + '"',
    '',
    'Here is the diff stat:',
    diffStat || '(no stat)',
    '',
    'Here is the full diff (may be truncated):',
    (diff || '').slice(0, 8000),
    '',
    'Write a PR body in this format:',
    '## Summary',
    '<2-3 bullet points explaining what changed and why>',
    '',
    '## Changes',
    '<brief description of each modified file/component>',
    '',
    '## Test plan',
    '<how to verify this works>',
    '',
    '---',
    '_🏔 산장에서 보냄_',
    '',
    'Write in Korean if the commit message is Korean, English otherwise.',
    'Be concise. No filler. Just the facts.',
  ].join('\n');
}
