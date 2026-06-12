'use strict';

async function loadCurrentUserDocs(insforge) {
  const user = await insforge.auth.getCurrentUser();
  const { data, error } = await insforge.database
    .from('docs')
    .select('id')
    .eq('user_id', user.id);
  if (error) throw error;
  return data || [];
}

module.exports = { loadCurrentUserDocs };
