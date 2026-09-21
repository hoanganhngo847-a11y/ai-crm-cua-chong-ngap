/* eslint-disable @typescript-eslint/no-require-imports */
// Node on restricted Windows sandboxes can throw ENOMEM from os.userInfo before tsx starts.
const os = require('node:os');
try {
  os.userInfo();
} catch {
  os.userInfo = () => ({ username: 'test-runner' });
}

const { register } = require('tsx/cjs/api');
register();
require('./voice.integration.test.ts');
