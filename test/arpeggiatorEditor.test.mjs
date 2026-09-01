import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultArpeggiatorContent } from '../src/renderer/js/core/arpeggiatorState.js';
import {
  currentArpeggiatorStep, editedSemitoneOffset, moveCustomNote, removeCustomNote,
  renderArpControlStrip, renderCustomPatternEditor, scaleContainsOffset, setCustomGateDuration,
  setCustomNote, snapSemitoneOffset, velocityFromPointer
} from '../src/renderer/js/core/arpeggiatorEditor.js';
import { renderArpeggiatorEditor } from '../src/renderer/js/core/nodeInstances.js';

function customState(){const state=defaultArpeggiatorContent();state.mode='Custom';state.scale='Natural Minor / Aeolian';state.patternLength=8;return state;}

test('scale highlighting is guidance and chromatic drawing remains free by default',()=>{
  const state=customState();
  assert.equal(scaleContainsOffset(state.scale,3),true);
  assert.equal(scaleContainsOffset(state.scale,6),false);
  setCustomNote(state,0,6);
  assert.equal(state.customPattern[0].semitoneOffset,6);
  assert.equal(state.customPattern[0].rest,false);
});

test('the Bay opens straight onto the full editor, with no intermediate step',()=>{
  const state=defaultArpeggiatorContent();
  const instance={name:'Arpeggiator 1',content:state};
  const preset=renderArpeggiatorEditor(instance,{});
  // Preset mode ("Up" by default) must already show the complete editor.
  assert.equal(state.mode,'Up');
  assert.match(preset,/data-arp-roll-scroll/);
  assert.match(preset,/data-arp-velocity-scroll/);
  assert.doesNotMatch(preset,/data-arp-action="open-custom"/,'the "Open Custom Editor" step is gone');
  assert.doesNotMatch(preset,/Custom Pattern Editor/);
  state.mode='Custom';
  assert.match(renderArpeggiatorEditor(instance,{}),/data-arp-roll-scroll/);
});

test('the control strip keeps every setting on real form controls',()=>{
  const html=renderArpControlStrip(customState());
  for(const control of ['root','scale','mode','rate','patternLength','snapToScale']){
    assert.match(html,new RegExp(`data-arp-control="${control}"`),`${control} is still user-editable`);
  }
  assert.match(html,/<select /,'selectors stay native selects (keyboard + accessibility)');
  assert.match(html,/type="checkbox"[^>]*data-arp-control="snapToScale"/,'Snap to Scale stays a real checkbox');
  assert.doesNotMatch(html,/style=/,'the strip complies with the renderer CSP');
});

test('knob geometry is expressed as SVG attributes, never as inline style',()=>{
  const state=customState();
  const low=renderArpControlStrip({...state,root:0});
  const high=renderArpControlStrip({...state,root:11});
  assert.match(low,/data-op-knob-arc/);
  assert.notEqual(
    low.match(/data-op-knob-pointer transform="([^"]+)"/)[1],
    high.match(/data-op-knob-pointer transform="([^"]+)"/)[1],
    'the pointer angle follows the value'
  );
});

test('Snap to Scale affects only new edits and equal distances prefer downward',()=>{
  const state=customState();setCustomNote(state,0,6);
  state.snapToScale=true;
  assert.equal(state.customPattern[0].semitoneOffset,6,'enabling snap does not rewrite stored notes');
  assert.equal(snapSemitoneOffset(state.scale,6),5);
  assert.equal(editedSemitoneOffset(state,6),5);
  setCustomNote(state,1,6);
  assert.equal(state.customPattern[1].semitoneOffset,5);
});

test('notes move vertically and horizontally with one authoritative step value',()=>{
  const state=customState();setCustomGateDuration(state,0,2,.6);
  moveCustomNote(state,0,3,11);
  assert.equal(state.customPattern[0].rest,true);
  assert.deepEqual(state.customPattern.slice(3,6).map((step)=>[step.semitoneOffset,step.rest,step.tie]),[
    [11,false,false],[4,true,true],[5,true,true]
  ]);
  assert.equal(state.customPattern.filter((step)=>!step.rest&&!step.tie&&step.semitoneOffset===11).length,1);
});

test('remove maps the selected note to Rest and clears its following Tie extension',()=>{
  const state=customState();setCustomGateDuration(state,2,4,.7);removeCustomNote(state,2);
  assert.deepEqual(state.customPattern.slice(2,5).map((step)=>[step.rest,step.tie]),[[true,false],[true,false],[true,false]]);
});

test('gate duration maps crossed steps onto Tie and replaces covered notes',()=>{
  const state=customState();setCustomGateDuration(state,0,3,.4);
  assert.equal(state.customPattern[0].gate,.4);
  assert.deepEqual(state.customPattern.slice(1,4).map((step)=>[step.rest,step.tie]),[[true,true],[true,true],[true,true]]);
  setCustomGateDuration(state,0,0,.8);
  assert.deepEqual(state.customPattern.slice(1,4).map((step)=>[step.rest,step.tie]),[[true,false],[true,false],[true,false]]);
});

test('visual editor exposes chromatic cells, note length, velocity, snap and no degree model',()=>{
  const state=customState();state.customPattern[0].semitoneOffset=6;setCustomGateDuration(state,0,2,.5);
  const html=renderCustomPatternEditor(state,0);
  assert.match(html,/data-arp-offset="6"/);
  assert.match(html,/class="arp-roll arp-steps-8"/);
  // Note length is a percentage of one step column, so the grid stays fluid:
  // 2 tied steps + a 0.5 gate = 2.5 columns.
  assert.match(html,/class="arp-roll-note selected" width="250%"/);
  assert.match(html,/data-arp-velocity="0"/);
  assert.match(html,/Snap to Scale/);
  assert.doesNotMatch(html,/Degree|data-arp-field="octave"/);
  assert.doesNotMatch(html,/style=/,'editor geometry must comply with the renderer CSP');
  assert.match(renderCustomPatternEditor(state,1),/<span>Tie<\/span>/,'a continuation step is identified as Tie, not merely Rest');
});

test('playhead math follows existing rates and pattern lengths',()=>{
  assert.equal(currentArpeggiatorStep(0,'1/16',8),0);
  assert.equal(currentArpeggiatorStep(.75,'1/16',8),3);
  assert.equal(currentArpeggiatorStep(2,'1/16',8),0);
  assert.equal(currentArpeggiatorStep(1.125,'1/32',4),1);
});

test('velocity pointer conversion clamps to the existing 1..127 field',()=>{
  const rect={top:10,bottom:110,height:100};
  assert.equal(velocityFromPointer(10,rect),127);
  assert.equal(velocityFromPointer(110,rect),1);
  assert.equal(velocityFromPointer(-100,rect),127);
  assert.equal(velocityFromPointer(300,rect),1);
});
