const { app } = require('electron');
const path = require('node:path');

const profile = process.env.DECKWISE_PLAYBACK_TEST_PROFILE;
if (!profile || !path.isAbsolute(profile)) {
  throw new Error('A dedicated absolute test profile is required');
}
app.setPath('userData', profile);
// Each test owns a window; keep the isolated test application alive between cases.
app.on('window-all-closed', () => {});
void app.whenReady();
