export const ARP_ROOTS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const ARP_SCALES = Object.freeze({
  Chromatic:[0,1,2,3,4,5,6,7,8,9,10,11], 'Major / Ionian':[0,2,4,5,7,9,11],
  'Natural Minor / Aeolian':[0,2,3,5,7,8,10], 'Harmonic Minor':[0,2,3,5,7,8,11],
  Dorian:[0,2,3,5,7,9,10], Phrygian:[0,1,3,5,7,8,10], Lydian:[0,2,4,6,7,9,11],
  Mixolydian:[0,2,4,5,7,9,10], Locrian:[0,1,3,5,6,8,10],
  'Major Pentatonic':[0,2,4,7,9], 'Minor Pentatonic':[0,3,5,7,10]
});
export const ARP_MODES = ['Up','Down','Up / Down','As Played','Random','Custom'];
export const ARP_RATES = ['1/4','1/8','1/16','1/32'];
export const ARP_LENGTHS = [4,8,16,32];
export const ARP_PATTERN_VERSION = 2;
export const ARP_OFFSET_MIN = -127;
export const ARP_OFFSET_MAX = 127;

const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function defaultArpeggiatorContent() {
  return { root:0, scale:'Chromatic', mode:'Up', rate:'1/16', patternLength:8, randomSeed:0x5eed1234,
    customPatternVersion:ARP_PATTERN_VERSION, snapToScale:false,
    customPattern:Array.from({length:32},(_,i)=>({semitoneOffset:i%7,velocity:100,gate:0.8,rest:false,tie:false})) };
}

/** Convert one legacy degree+octave step without changing its sounding pitch. */
export function legacyStepToSemitoneOffset(scaleName, degree, octave=0) {
  const scale=ARP_SCALES[scaleName]||ARP_SCALES.Chromatic;
  const index=Math.max(0,Math.trunc(degree)-1);
  return clamp(scale[index%scale.length]+12*(Math.floor(index/scale.length)+Math.trunc(octave||0)),ARP_OFFSET_MIN,ARP_OFFSET_MAX);
}

export function normalizeArpeggiatorContent(value) {
  const base=defaultArpeggiatorContent(), v=value&&typeof value==='object'?value:{};
  const scale=ARP_SCALES[v.scale]?v.scale:'Chromatic';
  const pattern=Array.from({length:32},(_,i)=>{const s=v.customPattern?.[i]||{};
    const semitoneOffset=Number.isInteger(s.semitoneOffset)
      ? s.semitoneOffset
      : (Number.isInteger(s.offset) ? s.offset
        : (Number.isInteger(s.degree)
          ? legacyStepToSemitoneOffset(scale,s.degree,s.octave)
          : base.customPattern[i].semitoneOffset));
    return {
    semitoneOffset:clamp(semitoneOffset,ARP_OFFSET_MIN,ARP_OFFSET_MAX), velocity:clamp(Number(s.velocity)||100,1,127),
    gate:clamp(Number.isFinite(Number(s.gate))?Number(s.gate):0.8,0.05,1), rest:s.rest===true, tie:s.tie===true
  }});
  return {root:clamp(Number.isInteger(v.root)?v.root:0,0,11),scale,
    mode:ARP_MODES.includes(v.mode)?v.mode:'Up',rate:ARP_RATES.includes(v.rate)?v.rate:'1/16',
    patternLength:ARP_LENGTHS.includes(v.patternLength)?v.patternLength:8,
    randomSeed:Number.isSafeInteger(v.randomSeed)?(v.randomSeed>>>0):base.randomSeed,
    customPatternVersion:ARP_PATTERN_VERSION,snapToScale:v.snapToScale===true,customPattern:pattern};
}

export function degreeToMidi(root, scaleName, degree, octave=0, baseOctave=4) {
  const scale=ARP_SCALES[scaleName]||ARP_SCALES.Chromatic;
  const index=Math.max(0,Math.trunc(degree)-1), scaleOctave=Math.floor(index/scale.length);
  return clamp(12*(baseOctave+1+octave+scaleOctave)+clamp(root,0,11)+scale[index%scale.length],0,127);
}

export function semitoneOffsetToMidi(root, semitoneOffset, baseOctave=4) {
  return clamp(12*(baseOctave+1)+clamp(root,0,11)+Math.trunc(semitoneOffset),0,127);
}
