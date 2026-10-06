const app = require('./index');

const payload = {
  pulseIds: [2935491434],
  columnId: "text_mm3k2qq2",
  columnValue: "5th Avenue"
};

const result = app.extractIdsFromPayload(payload);
console.log('extractIdsFromPayload result:', result);

const changed = app.extractChangedColumnIds(payload);
console.log('extractChangedColumnIds result:', changed);
