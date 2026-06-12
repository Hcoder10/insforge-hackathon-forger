'use strict';

async function sumAttachmentBytes(insforge) {
  const { data: files } = await insforge.storage.from('attachments').list();
  let totalBytes = 0;
  for (const file of files) {
    const { data: blob } = await insforge.storage.from('attachments').download(file.key);
    totalBytes += blob.size;
  }
  return { totalBytes };
}

async function removeExports(insforge, keys) {
  let removed = 0;
  for (const key of keys) {
    await insforge.storage.from('exports').remove(key);
    removed += 1;
  }
  return { removed };
}

module.exports = { sumAttachmentBytes, removeExports };
