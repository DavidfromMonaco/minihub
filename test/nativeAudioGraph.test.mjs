import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFullHub } from './helpers.mjs';
import { audioNodeValues, audioTopologyKey, buildRoutingSync, describeAudioGraph } from '../src/renderer/js/core/engineSync.js';

function rig() {
  const hub=makeFullHub();
  hub.graph.addNode({id:'audio-output',name:'Audio Output',type:'audio-output',inputs:[{id:'audio-in',type:'audio'}],outputs:[]});
  return hub;
}

test('Mixer ports grow with stable identities and graph contract is ordered',()=>{
  const hub=rig(); const a=hub.nodes.create('vst'),b=hub.nodes.create('vst'),m=hub.nodes.create('mixer');
  hub.graph.connect(a.id,'audio-out',m.id,'audio-in-1');
  assert.deepEqual(m.content.inputs.map((p)=>p.id),['audio-in-1','audio-in-2']);
  hub.graph.connect(b.id,'audio-out',m.id,'audio-in-2');
  assert.deepEqual(m.content.inputs.map((p)=>p.id),['audio-in-1','audio-in-2','audio-in-3']);
  hub.graph.disconnect(a.id,'audio-out',m.id,'audio-in-1');
  assert.deepEqual(m.content.inputs.map((p)=>p.id),['audio-in-1','audio-in-2','audio-in-3']);
  hub.graph.connect(m.id,'audio-out','audio-output','audio-in');
  const native=describeAudioGraph(hub).find((n)=>n.id===m.id);
  assert.deepEqual(native.inputs.map((p)=>p.portId),['audio-in-2']);
});

test('Mixer and Morpher state is serialized without audio data',()=>{
  const hub=rig(); const mixer=hub.nodes.create('mixer'),morpher=hub.nodes.create('morpher');
  mixer.content.inputs[0].level=.4;mixer.content.inputs[0].muted=true;mixer.content.masterLevel=.7;
  morpher.content.stepCount=16;morpher.content.steps[15]=.9;
  hub.nodes._persist(); const stored=hub.settings.data.nodeInstances;
  const m=stored.instances.find((n)=>n.id===mixer.id),x=stored.instances.find((n)=>n.id===morpher.id);
  assert.equal(m.content.inputs[0].level,.4);assert.equal(m.content.masterLevel,.7);
  assert.equal(x.content.stepCount,16);assert.equal(x.content.steps[15],.9);
  assert.equal(JSON.stringify(stored).includes('AudioBuffer'),false);
});

test('Morpher graph description preserves port order after reconnect',()=>{
  const hub=rig();const a=hub.nodes.create('vst'),b=hub.nodes.create('vst'),m=hub.nodes.create('morpher');
  hub.graph.connect(a.id,'audio-out',m.id,'audio-in-1');hub.graph.connect(b.id,'audio-out',m.id,'audio-in-2');
  hub.graph.disconnect(a.id,'audio-out',m.id,'audio-in-1');hub.graph.connect(a.id,'audio-out',m.id,'audio-in-1');
  const inputs=describeAudioGraph(hub).find((n)=>n.id===m.id).inputs;
  assert.deepEqual(inputs.map((p)=>p.sourceNodeId),[a.id,b.id]);
});

test('Sequencer is the integrated AUDIO DAG source for arrangement playback',()=>{
  const hub=rig();
  hub.graph.addNode({id:'sequencer',name:'Sequencer',type:'sequencer',inputs:[],outputs:[{id:'audio-out',type:'audio'}]});
  hub.graph.connect('sequencer','audio-out','audio-output','audio-in');
  const native=describeAudioGraph(hub),seq=native.find((node)=>node.id==='sequencer'),out=native.find((node)=>node.id==='audio-output');
  assert.deepEqual(seq.inputs,[]);
  assert.equal(out.inputs[0].sourceNodeId,'sequencer');assert.equal(out.inputs[0].sourcePortId,'audio-out');
});

test('physical Audio Input is a real routing-only AUDIO DAG source',()=>{
  const hub=rig();
  hub.nodes.create('audio-input');
  hub.graph.addNode({
    id:'sequencer',name:'Sequencer',type:'sequencer',
    inputs:[{id:'audio-in',type:'audio'}],outputs:[{id:'audio-out',type:'audio'}]
  });
  hub.graph.connect('audio-input','audio-out','sequencer','audio-in');
  const native=describeAudioGraph(hub);
  const input=native.find((node)=>node.id==='audio-input');
  const sequencer=native.find((node)=>node.id==='sequencer');
  assert.deepEqual(input,{id:'audio-input',nodeType:'audio-input',inputs:[]});
  assert.deepEqual(sequencer.inputs,[{
    portId:'audio-in',sourceNodeId:'audio-input',sourcePortId:'audio-out',level:1,muted:false
  }]);
});

test('a level or mute edit is not a topology change',()=>{
  const hub=rig(); const a=hub.nodes.create('vst'),m=hub.nodes.create('mixer');
  hub.graph.connect(a.id,'audio-out',m.id,'audio-in-1');
  hub.graph.connect(m.id,'audio-out','audio-output','audio-in');
  const before=describeAudioGraph(hub);
  const topologyBefore=audioTopologyKey(before);
  m.content.inputs[0].level=0.42;
  m.content.masterLevel=0.7;
  const after=describeAudioGraph(hub);
  assert.equal(audioTopologyKey(after),topologyBefore,'shape is unchanged');
  assert.notEqual(JSON.stringify(audioNodeValues(after)),
                  JSON.stringify(audioNodeValues(before)),'values did change');
  const mixerValues=audioNodeValues(after).find((n)=>n.id===m.id);
  assert.equal(mixerValues.masterLevel,0.7);
  assert.equal(mixerValues.inputs[0].level,0.42);
});

test('connecting a cable IS a topology change',()=>{
  const hub=rig(); const a=hub.nodes.create('vst'),m=hub.nodes.create('mixer');
  hub.graph.connect(a.id,'audio-out',m.id,'audio-in-1');
  const before=audioTopologyKey(describeAudioGraph(hub));
  hub.graph.connect(m.id,'audio-out','audio-output','audio-in');
  assert.notEqual(audioTopologyKey(describeAudioGraph(hub)),before);
});

test('a fader drag sends values in place and never recompiles the graph',()=>{
  const hub=rig(); const a=hub.nodes.create('vst'),m=hub.nodes.create('mixer');
  hub.graph.connect(a.id,'audio-out',m.id,'audio-in-1');
  hub.graph.connect(m.id,'audio-out','audio-output','audio-in');
  const calls=[];
  hub.engine={
    setChainMidiEnabled(){}, syncMidiGraph(){},
    syncAudioGraph(nodes){calls.push(['syncAudioGraph',nodes.length]);},
    setAudioNodeValues(nodes){calls.push(['setAudioNodeValues',nodes.length]);}
  };
  const sync=buildRoutingSync(hub);
  sync();
  assert.deepEqual(calls.map((c)=>c[0]),['syncAudioGraph'],'first publish sends the graph');
  // A drag: many distinct values, identical shape.
  for(const level of [0.9,0.8,0.7,0.6,0.5]){ m.content.inputs[0].level=level; sync(); }
  assert.deepEqual(calls.map((c)=>c[0]),
    ['syncAudioGraph','setAudioNodeValues','setAudioNodeValues','setAudioNodeValues',
     'setAudioNodeValues','setAudioNodeValues'],
    'the drag never recompiles the native plan');
  // An unchanged sync sends nothing at all.
  const settled=calls.length; sync();
  assert.equal(calls.length,settled,'an idempotent sync is silent');
});

test('a Morpher step is a value, its step count is topology',()=>{
  const hub=rig(); const p=hub.nodes.create('morpher');
  const before=describeAudioGraph(hub);
  p.content.steps[0]=0.25;
  assert.equal(audioTopologyKey(describeAudioGraph(hub)),audioTopologyKey(before),
               'moving a step keeps the shape');
  p.content.stepCount=8;
  assert.notEqual(audioTopologyKey(describeAudioGraph(hub)),audioTopologyKey(before),
                  'resizing the pattern is a recompile');
});
