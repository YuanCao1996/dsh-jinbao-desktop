import { scopeOf } from '@deepseek-ai/dsh-scope';

const GAME_TOOLS = ['site_datasets', 'site_query', 'web_search', 'web_fetch'];

export function configureGameAgent(ctx, preset) {
  if (preset !== 'jinbao-game') return;
  const scope = scopeOf(ctx);
  const inherited = ctx.tools.view?.(scope).restrictableNames;
  const allow = GAME_TOOLS.filter(name => ctx.tools.get(name, scope) && (!inherited || inherited.has(name)));
  if (!allow.length) throw Error('Game retrieval tools are not available');
  ctx.tools.restrict({ allow });
  ctx.tools.presentAs('native');
}
