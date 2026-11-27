import { httpJson, resolveLiveTarget } from './phonebox-client.mjs';

async function main() {
  let raw = '';
  if (!process.stdin.isTTY) {
    raw = await new Promise((resolve) => {
      const chunks = [];
      process.stdin.on('data', c => chunks.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 200);
    });
  }
  let d = {};
  try { if (raw.trim()) d = JSON.parse(raw); } catch (_) { return; }

  const cw = d.context_window || {};
  const cur = cw.current_usage || {};
  const body = {
    source: 'cli',
    planTier: d.plan_tier || 'CLI',
    agentState: d.agent_state || 'idle',
    model: d.model?.display_name || d.model?.id || '',
    conversationId: d.conversation_id || '',
    contextTokens: Number(cur.input_tokens || 0) + Number(cur.cache_read_input_tokens || 0) || Math.round((Number(cw.used_percentage || 0) / 100) * Number(cw.context_window_size || 1048576)),
    contextLimit: Number(cw.context_window_size || 1048576),
    sessionIn: Number(cw.total_input_tokens || 0),
    sessionOut: Number(cw.total_output_tokens || 0),
    sessionCached: Number(cur.cache_read_input_tokens || 0),
    quota: d.quota || {},
    costUsd: Number(d.cost?.total_usd || 0)
  };
  const target = await resolveLiveTarget(400);
  if (target.online) await httpJson('POST', `${target.base}/api/agy/status`, body, target, 450);

  const ctxPct = cw.used_percentage != null ? `${Math.round(cw.used_percentage)}%` : '--';
  const qFirst = Object.values(d.quota || {})[0];
  const qStr = qFirst && typeof qFirst.remaining_fraction === 'number' ? ` · Quota ${Math.round(qFirst.remaining_fraction * 100)}% left` : '';
  process.stdout.write(`F.R.I.D.A.Y. Sync${qStr} · Ctx ${ctxPct}`);
}

main().catch(() => {});
