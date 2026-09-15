import { action, integer, number, toggle } from './commandRegistry.js';
import { SEQUENCER_NODE_ID } from './systemNodes.js';
import { TEMPO_MAX, TEMPO_MIN } from './tempoControl.js';

/**
 * What the Sequencer's CTRL IN accepts (commandBus.js).
 *
 * Each command is a button of the Sequencer page, through the controller that
 * button calls -- so Record keeps every guard a click meets: no take without an
 * armed track and a cabled input, and the reason sentence the page would show
 * comes back to the plugin's window instead. Nothing here reaches the engine.
 *
 * Returned whether or not the Sequencer node exists: a command only arrives
 * along a cable into that node, so without it nothing is published, and a hold
 * such as Record can still be released when the node is deleted under it.
 */

// Quarter notes. The field has to end somewhere; this is past six hours of
// arrangement at 240 BPM, longer than any project the timeline can draw.
const SEEK_MAX_PPQ = 100000;

export function sequencerCommands(hub) {
  const controller = hub.sequencer;
  if (!controller?.model) return [];
  const tracks = controller.model.state.tracks;

  const recordOn = () => {
    // Repeated RECORD_ON is not a second take.
    if (controller.recording) return true;
    const reason = controller.recordBlockReason();
    return reason ? { ok: false, reason: 'record-blocked', message: reason } : controller.startRecording();
  };

  return [
    {
      id: SEQUENCER_NODE_ID,
      label: 'Sequencer',
      commands: [
        action('PLAY', 'Play', () => controller.playTransport(), 'STOP'),
        action('STOP', 'Stop', () => controller.stopTransport()),
        action('RESTART', 'Restart', () => controller.goToStart() && controller.playTransport()),
        action('RECORD_ON', 'Record on', recordOn, 'RECORD_OFF'),
        // Ends the take and leaves the transport running, as the page's Record button does.
        action('RECORD_OFF', 'Record off', () => (controller.recording ? controller.stopRecording() : true)),
        action('RETURN_START', 'Return to start', () => controller.goToStart()),
        action('RETURN_END', 'Return to end', () => controller.goToEnd()),
        number('SEEK', 'Position (quarter notes)', 0, SEEK_MAX_PPQ, (ppq) => controller.seek(ppq)),
        integer('TEMPO', 'Tempo', TEMPO_MIN, TEMPO_MAX, (bpm) => {
          controller.setTempo(bpm);
          return true;
        }),
        toggle('METRONOME', 'Metronome', (enabled) => {
          controller.setMetronome(enabled);
          return true;
        }),
        ...(tracks.length ? [integer('TRACK_SELECT', 'Select track (number)', 1, tracks.length, (position) => {
          const track = controller.model.state.tracks[position - 1];
          return track ? controller.focusTrack(track.id) : false;
        })] : [])
      ]
    },
    ...tracks.map((track) => ({
      id: `${SEQUENCER_NODE_ID}:track:${track.id}`,
      label: `Sequencer / ${track.name}`,
      commands: [
        // What a click on the track does: it takes the focus, and a MIDI track
        // becomes the one the keyboard plays.
        action('SELECT', 'Select', () => controller.focusTrack(track.id)),
        toggle('MUTE', 'Mute', (muted) => controller.setTrackControl(track.id, { muted })),
        number('VOLUME', 'Volume', 0, 2, (volume) => controller.setTrackControl(track.id, { volume })),
        // Added to the armed tracks rather than replacing them, so a step that
        // arms one track never disarms another a take is running on.
        toggle('ARM', 'Arm', (armed) => controller.setTrackArmed(track.id, armed, { additive: true })),
        toggle('MONITOR', 'Monitor', (monitored) => controller.setTrackMonitored(track.id, monitored))
      ]
    }))
  ];
}
