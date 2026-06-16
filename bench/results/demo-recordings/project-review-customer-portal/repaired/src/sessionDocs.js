'use strict';

async function loadCurrentUserDocs(insforge) {
  const { data: userAuthData, error: userAuthError } = await insforge.auth.getCurrentUser();
  if (userAuthError) throw userAuthError;
  const user = userAuthData?.user || userAuthData;
  const { data, error } = await insforge.database
    .from('docs')
    .select('id')
    .eq('user_id', user.id);
  if (error) throw error;
  return data || [];
}

module.exports = { loadCurrentUserDocs };
