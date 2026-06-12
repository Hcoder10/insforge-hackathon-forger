'use strict';

async function createProfile(insforge, profile) {
  const { data, error } = await insforge.database
    .from('profiles')
    .insert(profile)
    .select();
  if (error) throw error;
  return data[0];
}

module.exports = { createProfile };
