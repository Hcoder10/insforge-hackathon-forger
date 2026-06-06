// forger-bench — task registry. (docs/DESIGN.md §9)
'use strict';

const db = require('./db');
const vector = require('./vector');
const storage = require('./storage');
const ai = require('./ai');
const auth = require('./auth');

const ALL = [
  ...db.tasks,
  ...vector.tasks,
  ...storage.tasks,
  ...ai.tasks,
  ...auth.tasks,
];

const byId = new Map(ALL.map((t) => [t.id, t]));

module.exports = {
  ALL,
  TEST: ALL.filter((t) => t.split === 'test'),
  TRAIN: ALL.filter((t) => t.split === 'train'),
  get: (id) => byId.get(id),
};
