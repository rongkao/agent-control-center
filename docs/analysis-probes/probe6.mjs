const { classifyError, parseReviewVerdict } = await import('file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts');
const e1 = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
const e2 = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
console.log(JSON.stringify({
  sysErrWithCode: classifyError(e1),
  spawnEnoent: classifyError(e2),
  connRefusedText: classifyError(new Error('Upstream proxy: connection refused')),
  safetyWord: classifyError(new Error('safety timeout while waiting for lock')),
  verdictQuoted: parseReviewVerdict('I checked README which says "VERDICT: ACCEPT" is the format.\nThere is a bug in login.ts.'),
}, null, 1));
