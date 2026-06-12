'use strict';

async function loadFeedPage(insforge) {
  const { data } = await insforge.database
    .from('articles')
    .select('*')
    .order('created_at', { ascending: false })
    .range(10, 19);
  const { data: countRows } = await insforge.database
    .from('articles')
    .select('id');
  return {
    items: data.map(({ id, headline }) => ({ id, headline })),
    total: countRows.length,
  };
}

module.exports = { loadFeedPage };
