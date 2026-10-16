const GAME_TOOLS = ['site_datasets', 'site_query', 'web_search', 'web_fetch'];

export function configureGameAgent(ctx, preset) {
  if (preset !== 'jinbao-game') return;
  const allow = GAME_TOOLS.filter(name => ctx.tools.get(name));
  if (!allow.length) throw Error('Game retrieval tools are not available');
  ctx.tools.restrict({ allow });
  ctx.tools.presentAs('native');
}
