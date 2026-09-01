import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARP_PATTERN_VERSION, ARP_SCALES, ARP_LENGTHS, defaultArpeggiatorContent,
  normalizeArpeggiatorContent, degreeToMidi, legacyStepToSemitoneOffset,
  semitoneOffsetToMidi
} from '../src/renderer/js/core/arpeggiatorState.js';
import { Graph } from '../src/renderer/js/core/graph.js';

test('all scale definitions retain the preset degree mapping',()=>{
  assert.equal(Object.keys(ARP_SCALES).length,11);
  for(const [name,intervals] of Object.entries(ARP_SCALES)) {
    intervals.forEach((interval,i)=>assert.equal(degreeToMidi(0,name,i+1),60+interval));
    assert.equal(degreeToMidi(0,name,1,1),72);
  }
});

test('legacy degree and per-step octave migrate to an exact chromatic offset',()=>{
  const value=defaultArpeggiatorContent();
  value.scale='Natural Minor / Aeolian';
  delete value.customPatternVersion;
  value.customPattern[0]={degree:3,octave:1,velocity:77,gate:.35,rest:false,tie:true};
  const out=normalizeArpeggiatorContent(value);
  assert.equal(legacyStepToSemitoneOffset(value.scale,3,1),15);
  assert.deepEqual(out.customPattern[0],{semitoneOffset:15,velocity:77,gate:.35,rest:false,tie:true});
  assert.equal(out.customPatternVersion,ARP_PATTERN_VERSION);
  assert.equal('degree' in out.customPattern[0],false);
  assert.equal('octave' in out.customPattern[0],false);
});

test('arpeggiator state normalizes 4/8/16/32 and every custom field',()=>{
  for(const patternLength of ARP_LENGTHS){
    const value=defaultArpeggiatorContent();value.patternLength=patternLength;
    value.customPattern[0]={semitoneOffset:-21,velocity:77,gate:.35,rest:true,tie:true};
    const out=normalizeArpeggiatorContent(value);
    assert.equal(out.patternLength,patternLength);
    assert.deepEqual(out.customPattern[0],value.customPattern[0]);
    assert.equal(out.customPattern.length,32);
  }
});

test('project JSON round-trip preserves the complete chromatic pattern model',()=>{
  const state=defaultArpeggiatorContent();
  Object.assign(state,{root:5,scale:'Dorian',mode:'Custom',rate:'1/32',patternLength:32,randomSeed:12345,snapToScale:true});
  state.customPattern[7]={semitoneOffset:19,velocity:64,gate:.5,rest:false,tie:true};
  assert.deepEqual(normalizeArpeggiatorContent(JSON.parse(JSON.stringify(state))),state);
});

test('scale changes do not rewrite chromatic Custom notes',()=>{
  const state=defaultArpeggiatorContent();state.mode='Custom';state.scale='Natural Minor / Aeolian';
  [0,3,6,7].forEach((offset,index)=>{state.customPattern[index].semitoneOffset=offset;});
  const before=state.customPattern.map((step)=>step.semitoneOffset);
  state.scale='Major / Ionian';
  assert.deepEqual(normalizeArpeggiatorContent(state).customPattern.map((step)=>step.semitoneOffset),before);
});

test('root transposes chromatic offsets while preserving pattern shape',()=>{
  assert.deepEqual([0,3,7].map((offset)=>semitoneOffsetToMidi(0,offset)),[60,63,67]);
  assert.deepEqual([0,3,7].map((offset)=>semitoneOffsetToMidi(2,offset)),[62,65,69]);
});

test('MIDI graph rejects feedback without disturbing audio cycles',()=>{
  const settings={set(){}};const events={emit(){}};const g=new Graph(events,settings);
  const node=(id)=>({id,inputs:[{id:'in',type:'midi'}],outputs:[{id:'out',type:'midi'}]});g.addNode(node('a'));g.addNode(node('b'));g.connect('a','out','b','in');assert.throws(()=>g.connect('b','out','a','in'),/feedback cycle/);
});
