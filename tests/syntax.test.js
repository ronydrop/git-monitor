const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    throw err;
  }
}

test('main process JavaScript has valid syntax', () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'main.js')], {
      stdio: 'pipe'
    });
  });
});
