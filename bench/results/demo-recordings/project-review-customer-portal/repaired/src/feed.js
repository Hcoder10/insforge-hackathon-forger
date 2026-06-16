'use strict';

async function loadFeedPage(insforge) {
  const { data, count, error } = await insforge.database
    .from('articles')
    .select('id, headline', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(10, 19);
  if (error) throw error;
  return {
    items: data.map(({ id, headline }) => ({ id, headline })),
    total: count,
  };
}

module.exports = { loadFeedPage };
