import {
  ARP_ROOTS, ARP_SCALES, ARP_MODES, ARP_RATES, ARP_LENGTHS,
  ARP_OFFSET_MIN, ARP_OFFSET_MAX, semitoneOffsetToMidi
} from './arpeggiatorState.js';
import { knobFraction, pearlKnobMount, pearlSelect, pearlSwitch, pearlIconButton, syncKnobMount } from '../ui/omniPearl.js';

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const modulo=(value,base)=>((value%base)+base)%base;

export function scaleContainsOffset(scaleName, semitoneOffset) {
  const scale=ARP_SCALES[scaleName]||ARP_SCALES.Chromatic;
  return scale.includes(modulo(Math.trunc(semitoneOffset),12));
}

/** Nearest scale pitch across adjacent octaves. Equal distances prefer down. */
export function snapSemitoneOffset(scaleName, semitoneOffset) {
  const requested=clamp(Math.trunc(semitoneOffset),ARP_OFFSET_MIN,ARP_OFFSET_MAX);
  if(scaleContainsOffset(scaleName,requested))return requested;
  for(let distance=1;distance<=12;distance+=1){
    const lower=requested-distance, upper=requested+distance;
    if(lower>=ARP_OFFSET_MIN&&scaleContainsOffset(scaleName,lower))return lower;
    if(upper<=ARP_OFFSET_MAX&&scaleContainsOffset(scaleName,upper))return upper;
  }
  return requested;
}

export function editedSemitoneOffset(content, requested) {
  const bounded=clamp(Math.trunc(requested),ARP_OFFSET_MIN,ARP_OFFSET_MAX);
  return content.snapToScale?snapSemitoneOffset(content.scale,bounded):bounded;
}

export function setCustomNote(content, stepIndex, requestedOffset) {
  const step=content.customPattern[stepIndex];if(!step)return false;
  step.semitoneOffset=editedSemitoneOffset(content,requestedOffset);step.rest=false;step.tie=false;return true;
}

export function clearFollowingTies(content, stepIndex) {
  for(let index=stepIndex+1;index<content.patternLength&&content.customPattern[index]?.tie;index+=1){
    content.customPattern[index].tie=false;
    content.customPattern[index].rest=true;
  }
}

export function removeCustomNote(content, stepIndex) {
  const step=content.customPattern[stepIndex];if(!step)return false;
  clearFollowingTies(content,stepIndex);step.rest=true;step.tie=false;return true;
}

export function moveCustomNote(content, fromStep, toStep, requestedOffset) {
  const source=content.customPattern[fromStep],destination=content.customPattern[toStep];
  if(!source||!destination)return false;
  const semitoneOffset=editedSemitoneOffset(content,requestedOffset);
  if(fromStep===toStep){source.semitoneOffset=semitoneOffset;source.rest=false;source.tie=false;return true;}
  let tieCount=0;
  for(let index=fromStep+1;index<content.patternLength&&content.customPattern[index]?.tie;index+=1)tieCount+=1;
  const moved={...source,semitoneOffset,rest:false,tie:false};
  clearFollowingTies(content,fromStep);
  clearFollowingTies(content,toStep);
  Object.assign(source,{rest:true,tie:false});
  Object.assign(destination,moved);
  for(let index=toStep+1;index<=Math.min(content.patternLength-1,toStep+tieCount);index+=1){
    content.customPattern[index].rest=true;
    content.customPattern[index].tie=true;
  }
  return true;
}

/** Resize within one step; dragging across steps maps the extension to Tie. */
export function setCustomGateDuration(content, stepIndex, endStep, finalFraction) {
  const source=content.customPattern[stepIndex];if(!source)return false;
  clearFollowingTies(content,stepIndex);
  const last=clamp(Math.trunc(endStep),stepIndex,content.patternLength-1);
  source.gate=clamp(Number(finalFraction)||0.05,0.05,1);
  for(let index=stepIndex+1;index<=last;index+=1){
    if(!content.customPattern[index].rest&&!content.customPattern[index].tie)clearFollowingTies(content,index);
  }
  for(let index=stepIndex+1;index<=last;index+=1){
    content.customPattern[index].rest=true;
    content.customPattern[index].tie=true;
  }
  return true;
}

export function velocityFromPointer(clientY,rect) {
  if(!rect||!(rect.height>0))return 100;
  return clamp(Math.round((rect.bottom-clientY)/rect.height*126)+1,1,127);
}

export function currentArpeggiatorStep(ppqPosition,rate,patternLength) {
  const durations={'1/4':1,'1/8':.5,'1/16':.25,'1/32':.125};
  const length=[4,8,16,32].includes(patternLength)?patternLength:8;
  const absolute=Math.floor(Math.max(0,Number(ppqPosition)||0)/(durations[rate]||.25));
  return absolute%length;
}

export function pitchRowsForPattern(content) {
  const active=content.customPattern.slice(0,content.patternLength)
    .filter((step)=>!step.rest&&!step.tie).map((step)=>step.semitoneOffset);
  const highest=Math.max(24,...active),lowest=Math.min(-24,...active);
  return {highest:clamp(Math.ceil(highest/12)*12,ARP_OFFSET_MIN,ARP_OFFSET_MAX),
    lowest:clamp(Math.floor(lowest/12)*12,ARP_OFFSET_MIN,ARP_OFFSET_MAX)};
}


function followingTieCount(content,stepIndex){let count=0;for(let i=stepIndex+1;i<content.patternLength&&content.customPattern[i]?.tie;i+=1)count+=1;return count;}
function noteName(root,offset){return ARP_ROOTS[modulo(root+offset,12)];}

/** Sounding pitch of a row, e.g. `C4` - the label the keybed prints. */
export function pitchLabel(root,offset){
  const midi=semitoneOffsetToMidi(root,offset);
  return `${ARP_ROOTS[modulo(midi,12)]}${Math.floor(midi/12)-1}`;
}
function isBlackKey(root,offset){return noteName(root,offset).includes('#');}
/** Note width as a percentage of ONE step column: the grid stays fluid. */
function notePercent(duration){return `${Math.round(duration*10000)/100}%`;}
const signed=(offset)=>`${offset>0?'+':''}${offset}`;

const TRASH_ICON='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>';

/**
 * The hardware control strip (SPEC of the Omni Pearl skin): the same five
 * settings as before, presented as rotaries / selectors / a tactile switch.
 * Values live in `content`; nothing here changes musical behaviour.
 */
export function renderArpControlStrip(content) {
  const roots=ARP_ROOTS.map((name,index)=>({value:index,label:name}));
  return `<div class="op-strip" data-arp-strip>
    <div class="op-strip-cell" data-arp-mount="root"><span class="op-label">ROOT</span>
      ${pearlKnobMount({options:roots,value:content.root,attrs:'data-arp-control="root"',ariaLabel:'Root note',display:ARP_ROOTS[content.root]})}</div>
    <div class="op-strip-cell op-strip-cell--grow"><span class="op-label">SCALE</span>
      ${pearlSelect({options:Object.keys(ARP_SCALES),value:content.scale,attrs:'data-arp-control="scale"',ariaLabel:'Scale'})}</div>
    <div class="op-strip-cell op-strip-cell--wide"><span class="op-label">MODE</span>
      ${pearlSelect({options:ARP_MODES,value:content.mode,attrs:'data-arp-control="mode"',ariaLabel:'Mode'})}</div>
    <div class="op-strip-cell" data-arp-mount="rate"><span class="op-label">RATE</span>
      ${pearlKnobMount({options:ARP_RATES,value:content.rate,attrs:'data-arp-control="rate"',ariaLabel:'Rate',valueBox:content.rate,small:true})}</div>
    <div class="op-strip-cell" data-arp-mount="steps"><span class="op-label">STEPS</span>
      ${pearlKnobMount({options:ARP_LENGTHS,value:content.patternLength,attrs:'data-arp-control="patternLength"',ariaLabel:'Steps',valueBox:String(content.patternLength),small:true})}</div>
    <div class="op-strip-cell op-strip-cell--end"><span class="op-label">Snap to Scale</span>
      ${pearlSwitch({checked:content.snapToScale,attrs:'data-arp-control="snapToScale"',ariaLabel:'Snap to Scale'})}</div>
  </div>`;
}

/**
 * Refresh the knobs in place after a value change.
 *
 * Re-rendering the strip would blur the `<select>` the user is driving and
 * break arrow-key editing, so only the SVG attributes and the printed value
 * are touched (see `syncKnobMount`).
 */
export function syncArpControlStrip(container, content) {
  if (!container || typeof container.querySelector !== 'function') return false;
  syncKnobMount(container.querySelector('[data-arp-mount="root"]'),
    {fraction:knobFraction(content.root,ARP_ROOTS.length),display:ARP_ROOTS[content.root]});
  syncKnobMount(container.querySelector('[data-arp-mount="rate"]'),
    {fraction:knobFraction(ARP_RATES.indexOf(content.rate),ARP_RATES.length),display:content.rate});
  syncKnobMount(container.querySelector('[data-arp-mount="steps"]'),
    {fraction:knobFraction(ARP_LENGTHS.indexOf(content.patternLength),ARP_LENGTHS.length),display:String(content.patternLength)});
  return true;
}

/**
 * Piano roll + velocity lane.
 *
 * Every chromatic row is drawn and stays editable: the scale only tints rows
 * as guidance, and `Snap to Scale` (strip switch) is what actually constrains
 * a new edit. Notes are sized in PERCENT of a step column so the grid follows
 * the window instead of a fixed pixel geometry, and the velocity lane reuses
 * the roll's column template so the two always line up.
 */
export function renderCustomPatternEditor(content,selectedStep=-1) {
  const {highest,lowest}=pitchRowsForPattern(content),steps=content.patternLength;
  const headers=Array.from({length:steps},(_,step)=>`<span class="arp-roll-step${step%4===0?' beat':''}" data-arp-step-marker="${step}">${step+1}</span>`).join('');
  let grid=`<span class="arp-roll-corner">NOTE</span>${headers}`;
  for(let offset=highest;offset>=lowest;offset-=1){
    const inScale=scaleContainsOffset(content.scale,offset),black=isBlackKey(content.root,offset),root=offset===0;
    const pitch=pitchLabel(content.root,offset),label=`${pitch} (${signed(offset)})`;
    grid+=`<span class="arp-pitch-label${black?' black-key':''}${inScale?' in-scale':''}${root?' root-row':''}"><span class="arp-pitch-name">${pitch}</span><span class="arp-pitch-offset">${signed(offset)}</span></span>`;
    for(let step=0;step<steps;step+=1){
      const state=content.customPattern[step],hasNote=!state.rest&&!state.tie&&state.semitoneOffset===offset;
      const duration=hasNote?followingTieCount(content,step)+state.gate:0;
      const width=notePercent(duration);
      grid+=`<button type="button" class="arp-roll-cell${step%4===0?' beat':''}${black?' black-row':''}${inScale?' in-scale':''}${root?' root-row':''}${hasNote?' has-note':''}" data-arp-cell data-arp-step="${step}" data-arp-offset="${offset}" aria-label="Step ${step+1}, ${label}">${hasNote?`<svg class="arp-roll-note ${selectedStep===step?'selected':''}" width="${width}" height="15" aria-hidden="true"><rect class="arp-note-body" x="0" y="0.5" width="100%" height="14" rx="4.5"></rect><rect class="arp-note-gloss" x="3%" y="2.5" width="94%" height="3" rx="1.5"></rect><rect class="arp-note-resize" data-arp-resize x="100%" transform="translate(-9 0)" y="0" width="9" height="15" rx="3"><title>Drag note length</title></rect></svg>`:''}</button>`;
    }
  }
  const velocity=content.customPattern.slice(0,steps).map((step,index)=>{
    const fill=Math.max(1,Math.round(step.velocity/127*1000)/10);
    return `<button type="button" class="arp-velocity-step${index%4===0?' beat':''}${step.rest||step.tie?' inactive':''}${selectedStep===index?' selected':''}" data-arp-velocity="${index}" aria-label="Step ${index+1} velocity ${step.velocity}"><svg class="arp-velocity-bar" aria-hidden="true"><rect class="arp-velocity-fill" x="30%" y="${100-fill}%" width="40%" height="${fill}%" rx="3"></rect><rect class="arp-velocity-cap" x="30%" y="${100-fill}%" width="40%" height="3" rx="1.5"></rect></svg><small>${step.velocity}</small></button>`;
  }).join('');
  const selected=content.customPattern[selectedStep];
  const inspector=selected
    ? `<div class="arp-note-inspector" data-arp-step="${selectedStep}"><strong>Step ${selectedStep+1}</strong><span>${selected.tie?'Tie':(selected.rest?'Rest':`${pitchLabel(content.root,selected.semitoneOffset)} ${signed(selected.semitoneOffset)}`)}</span><label>Gate <input type="range" min="0.05" max="1" step="0.05" value="${selected.gate}" data-arp-field="gate"></label><label><input type="checkbox" ${selected.rest?'checked':''} data-arp-field="rest"> Rest</label><label><input type="checkbox" ${selected.tie?'checked':''} data-arp-field="tie"> Tie</label></div>`
    : `<div class="arp-note-inspector"><span>No step selected</span><span class="op-hint">Click a cell to draw, drag a note to move it, drag its right edge for length, Delete removes it.</span></div>`;
  const hint=content.mode==='Custom'
    ? (content.snapToScale?'Snap to Scale on: new notes align to the selected scale.':'Snap to Scale off: every chromatic row is editable.')
    : `${content.mode} preset is playing - this pattern plays in Custom mode. Snap to Scale ${content.snapToScale?'on':'off'}.`;
  return `<section class="op-panel op-arp-pattern">
      <div class="op-panel-head"><span class="op-label accent">Pattern</span><span class="op-hint">${hint}</span><span class="op-spacer"></span>
        ${pearlIconButton({svg:TRASH_ICON,attrs:'data-arp-action="remove-note"',title:'Remove selected note',disabled:!selected})}</div>
      <div class="arp-roll-scroll" data-arp-roll-scroll><div class="arp-roll arp-steps-${steps}">${grid}</div></div>
      ${inspector}
    </section>
    <section class="op-panel op-arp-velocity">
      <div class="op-panel-head"><span class="op-label accent">Velocity</span><span class="op-hint">Drag a lane vertically - full 1..127 MIDI range.</span></div>
      <div class="arp-velocity" data-arp-velocity-scroll><div class="arp-velocity-grid arp-steps-${steps}"><span class="arp-velocity-axis"><span>127</span><span>64</span><span>0</span></span>${velocity}</div></div>
    </section>`;
}
