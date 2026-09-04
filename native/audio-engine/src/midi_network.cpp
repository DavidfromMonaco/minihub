#include "midi_network.h"
#include <algorithm>
#include <cmath>
#include <optional>
#include <unordered_set>

namespace mlh {
namespace {
constexpr std::array<std::array<int,12>,11> scales{{
 {{0,1,2,3,4,5,6,7,8,9,10,11}},{{0,2,4,5,7,9,11,-1,-1,-1,-1,-1}},{{0,2,3,5,7,8,10,-1,-1,-1,-1,-1}},
 {{0,2,3,5,7,8,11,-1,-1,-1,-1,-1}},{{0,2,3,5,7,9,10,-1,-1,-1,-1,-1}},{{0,1,3,5,7,8,10,-1,-1,-1,-1,-1}},
 {{0,2,4,6,7,9,11,-1,-1,-1,-1,-1}},{{0,2,4,5,7,9,10,-1,-1,-1,-1,-1}},{{0,1,3,5,6,8,10,-1,-1,-1,-1,-1}},
 {{0,2,4,7,9,-1,-1,-1,-1,-1,-1,-1}},{{0,3,5,7,10,-1,-1,-1,-1,-1,-1,-1}}
}};
int scaleSize(int s){int n=0;for(int v:scales[(size_t)std::clamp(s,0,10)])if(v>=0)++n;return n;}
}
ArpeggiatorRuntime::ArpeggiatorRuntime(ArpConfig c):config_(c),random_(c.randomSeed){output_.ensureSize(8192);}
double ArpeggiatorRuntime::stepQuarterNotes(int rate) noexcept { static constexpr double v[]={1,.5,.25,.125};return v[std::clamp(rate,0,3)]; }
int ArpeggiatorRuntime::degreeToMidi(int root,int scale,int degree,int octave,int baseOctave) noexcept {const int s=std::clamp(scale,0,10),n=scaleSize(s),i=std::max(0,degree-1);return std::clamp(12*(baseOctave+1+octave+i/n)+std::clamp(root,0,11)+scales[(size_t)s][(size_t)(i%n)],0,127);}
int ArpeggiatorRuntime::semitoneOffsetToMidi(int root,int semitoneOffset,int baseOctave) noexcept {return std::clamp(12*(baseOctave+1)+std::clamp(root,0,11)+std::clamp(semitoneOffset,-127,127),0,127);}
void ArpeggiatorRuntime::pushInput(const juce::MidiMessage& m) noexcept {const int n=m.getRawDataSize();if(n<1||n>3)return;int a,b,c,d;fifo_.prepareToWrite(1,a,b,c,d);if(b+d==0)return;auto& e=input_[(size_t)(b?a:c)];e.size=n;std::copy_n(m.getRawData(),n,e.bytes);fifo_.finishedWrite(1);}
void ArpeggiatorRuntime::applyInput(const juce::MidiMessage& m) noexcept {if(m.isNoteOn()){int note=m.getNoteNumber();auto it=std::find(held_.begin(),held_.begin()+heldCount_,note);if(it==held_.begin()+heldCount_&&heldCount_<128)held_[(size_t)heldCount_++]=note;}else if(m.isNoteOff()){int note=m.getNoteNumber();auto it=std::find(held_.begin(),held_.begin()+heldCount_,note);if(it!=held_.begin()+heldCount_){std::move(it+1,held_.begin()+heldCount_,it);--heldCount_;}}}
int ArpeggiatorRuntime::quantize(int note) const noexcept {int best=note,dist=128;for(int n=0;n<128;++n){const int pc=(n-config_.root+120)%12;bool ok=false;for(int i=0;i<scaleSize(config_.scale);++i)ok|=scales[(size_t)config_.scale][(size_t)i]==pc;if(ok&&std::abs(n-note)<dist){best=n;dist=std::abs(n-note);}}return best;}
int ArpeggiatorRuntime::presetNote(int64_t step) noexcept {if(!heldCount_)return -1;std::array<int,128> notes=held_;if(config_.mode!=3)std::sort(notes.begin(),notes.begin()+heldCount_);int i=(int)(step%std::max(1,config_.patternLength));if(config_.mode==1)i=heldCount_-1-(i%heldCount_);else if(config_.mode==2){int span=std::max(1,heldCount_*2-2),p=i%span;i=p<heldCount_?p:span-p;}else if(config_.mode==4){random_=random_*1664525u+1013904223u;i=(int)(random_%((uint32_t)heldCount_));}else i%=heldCount_;return quantize(notes[(size_t)i]);}
void ArpeggiatorRuntime::emit(const juce::MidiMessage& m,int sample) noexcept {output_.addEvent(m,std::max(0,sample));}
void ArpeggiatorRuntime::flush(const std::vector<MidiDestination>& dest,MidiOutputSink* hardware,double startMs,double sampleRate) noexcept {if(output_.isEmpty())return;bool hardwareUsed=false;for(const auto& d:dest){if(d.kind==MidiDestinationKind::physicalOutput)hardwareUsed=true;else if(d.chain)d.chain->pushMidi(output_,d.blockEpoch);}if(hardwareUsed&&hardware)hardware->sendBlock(output_,startMs,sampleRate);}
void ArpeggiatorRuntime::panic(const std::vector<MidiDestination>& dest,MidiOutputSink* hardware) noexcept {output_.clear();bool hardwareUsed=false;for(auto& a:active_)if(a.on){emit(juce::MidiMessage::noteOff(a.channel,a.note),0);a.on=false;}for(int channel=1;channel<=16;++channel){emit(juce::MidiMessage::allNotesOff(channel),0);emit(juce::MidiMessage::allSoundOff(channel),0);}for(const auto& d:dest){if(d.kind==MidiDestinationKind::physicalOutput)hardwareUsed=true;else if(d.chain){d.chain->panic();d.chain->pushMidi(output_,d.chain->midiEpoch());}}if(hardwareUsed&&hardware)hardware->panic();}
void ArpeggiatorRuntime::process(int samples,Transport& t,std::vector<MidiDestination>& dest,MidiOutputSink* hardware,double startMs,double sampleRate,const juce::MidiBuffer* scheduledInput) noexcept {
 for(auto& d:dest)if(d.chain)d.blockEpoch=d.chain->midiEpoch();
 output_.clear();const int available=fifo_.getNumReady();for(int k=0;k<available;++k){int a,b,c,d;fifo_.prepareToRead(1,a,b,c,d);if(b+d==0)break;auto&e=input_[(size_t)(b?a:c)];applyInput(juce::MidiMessage(e.bytes,e.size,0));fifo_.finishedRead(1);}
 if(!t.processingPlaying()||!t.playing()){if(wasPlaying_)panic(dest,hardware);wasPlaying_=false;lastStep_=std::numeric_limits<int64_t>::min();return;} wasPlaying_=true;
 const double delta=t.quarterNotesPerSample(),dur=stepQuarterNotes(config_.rate);if(samples<=0||delta<=0)return;
 std::optional<juce::MidiBuffer::Iterator> iterator;juce::MidiMessage scheduled;int scheduledSample=0;bool hasScheduled=false;if(scheduledInput){iterator.emplace(*scheduledInput);hasScheduled=iterator->getNextEvent(scheduled,scheduledSample);}
 double previous=t.ppqAtSample(0);for(int sample=0;sample<samples;++sample){const double q=t.ppqAtSample(sample);const bool wrapped=sample>0&&q+1.0e-9<previous;if(wrapped){for(auto&a:active_)if(a.on){emit(juce::MidiMessage::noteOff(a.channel,a.note),sample);a.on=false;}lastStep_=std::numeric_limits<int64_t>::min();}
  while(hasScheduled&&scheduledSample<=sample){applyInput(scheduled);hasScheduled=iterator->getNextEvent(scheduled,scheduledSample);}
  for(auto&a:active_)if(a.on&&!wrapped&&q+delta*.5>=a.endPpq){emit(juce::MidiMessage::noteOff(a.channel,a.note),sample);a.on=false;}
  const int64_t step=(int64_t)std::floor(q/dur+1.0e-9);const bool exact=std::abs(q-step*dur)<=delta*.55;bool trigger=false;if(lastStep_==std::numeric_limits<int64_t>::min()){lastStep_=step;trigger=exact;}else if(step!=lastStep_){lastStep_=step;trigger=true;}if(trigger){const int index=(int)((step%config_.patternLength+config_.patternLength)%config_.patternLength);int note=-1,vel=100,tiesAfter=0;float gate=.8f;bool tie=false,rest=false;if(config_.mode==5){const auto& st=config_.steps[(size_t)index];rest=st.rest;tie=st.tie;vel=st.velocity;gate=st.gate;if(heldCount_)note=semitoneOffsetToMidi(config_.root,st.semitoneOffset,held_[0]/12-1);for(int next=index+1;next<config_.patternLength&&config_.steps[(size_t)next].tie;++next)++tiesAfter;}else note=presetNote(step);if(!tie&&!rest&&note>=0){emit(juce::MidiMessage::noteOn(1,note,(juce::uint8)std::clamp(vel,1,127)),sample);for(auto&a:active_)if(!a.on){a={note,1,q+dur*(tiesAfter+std::clamp(gate,.05f,1.f)),true};break;}}}previous=q;}
 flush(dest,hardware,startMs,sampleRate);
}
std::unique_ptr<MidiExecutionPlan> MidiExecutionPlan::compile(const MidiNetworkSpec& spec,const std::function<Chain*(const std::string&)>& lookup,std::string& error){auto p=std::make_unique<MidiExecutionPlan>();
// Which destination ids mean "the hardware MIDI output" rather than a plugin
// chain. The engine used to answer that by comparing the id to the name of one
// keyboard (D-008, half-finished). It now reads the kind the renderer already
// sends for every node, so a second controller needs no C++ change at all.
std::unordered_set<std::string> physicalOutputs;for(const auto&s:spec.nodes)if(s.kind=="midi-output")physicalOutputs.insert(s.id);
std::unordered_set<std::string> ids;for(const auto&s:spec.nodes){if(s.kind!="arpeggiator")continue;if(!ids.insert(s.id).second){error="duplicate MIDI node";return{};}Node n;n.id=s.id;n.arp=std::make_unique<ArpeggiatorRuntime>(s.arp);n.scheduledInput.ensureSize(8192);for(const auto&d:s.destinations){if(physicalOutputs.count(d)!=0)n.destinations.push_back({MidiDestinationKind::physicalOutput,nullptr,0});else{auto*c=lookup(d);if(!c){error="unknown MIDI destination: "+d;return{};}n.destinations.push_back({MidiDestinationKind::chain,c,c->midiEpoch()});}}p->nodes_.push_back(std::move(n));}return p;}
void MidiExecutionPlan::process(int n,Transport&t,MidiOutputSink* hardware,double startMs,double sampleRate) noexcept {for(auto&x:nodes_){x.arp->process(n,t,x.destinations,hardware,startMs,sampleRate,&x.scheduledInput);x.scheduledInput.clear();}}
bool MidiExecutionPlan::pushInput(const std::string&id,const juce::MidiMessage&m) noexcept {for(auto&n:nodes_)if(n.id==id){n.arp->pushInput(m);return true;}return false;}
bool MidiExecutionPlan::pushInputBuffer(const std::string&id,const juce::MidiBuffer&input) noexcept {for(auto&n:nodes_)if(n.id==id){n.scheduledInput.addEvents(input,0,-1,0);return true;}return false;}
void MidiExecutionPlan::panicAll(MidiOutputSink* hardware) noexcept {for(auto&n:nodes_){n.scheduledInput.clear();n.arp->panic(n.destinations,hardware);}}
}
