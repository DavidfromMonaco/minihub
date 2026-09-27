/**
 * The node pages `app.js` installs at startup, installed once for a test file.
 *
 * Imported for its effect, first, by every test that builds a hub. Without it
 * a VST, Arpeggiator, Mixer or Morpher page opens on the generic shell, and a
 * test about that page goes on passing while it looks at an empty panel.
 * One Ring's and the Audio Player's pages are left to their own tests, which
 * install and remove them one test at a time.
 */
import { registerVstEditor } from '../src/renderer/js/modules/vst/vstEditor.js';
import { registerArpeggiatorEditor } from '../src/renderer/js/modules/arpeggiator/arpeggiatorPanel.js';
import { registerNativeAudioEditors } from '../src/renderer/js/modules/nativeAudio/nativeAudioEditor.js';

registerVstEditor();
registerArpeggiatorEditor();
registerNativeAudioEditors();
