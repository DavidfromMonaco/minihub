#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
namespace mlh {
inline float metronomeClickPhaseIncrement(bool accent, bool preCount) noexcept
{
 const float normal = accent ? 0.42f : 0.31f;
 return normal * (preCount ? 1.25f : 1.0f);
}

/** A time signature (D-059). The renderer is its authority; the engine keeps
 * the last one it was sent and never makes one up. A beat is the note value
 * the denominator names, so a bar of 7/8 is 3.5 quarters. */
struct TimeSig final {
 int numerator=4,denominator=4;
 static bool valid(int n,int d) noexcept { return n>=1&&n<=32&&(d==2||d==4||d==8||d==16); }
 double beatQuarters() const noexcept { return 4.0/double(denominator); }
 double barQuarters() const noexcept { return double(numerator)*beatQuarters(); }
 // One word, so a reader never sees the numerator of one signature with the
 // denominator of the one before.
 uint32_t pack() const noexcept { return (uint32_t(numerator)<<8)|uint32_t(denominator); }
 static TimeSig unpack(uint32_t v) noexcept { return {int(v>>8),int(v&0xffu)}; }
};

/** Where a signature begins, in quarters (D-061). The project's map is a
 * list of these from 0; a region lasts until the next one begins. */
struct MeterRegion final {
 double startPpq=0.0;
 TimeSig sig{};
};

struct MetronomeTick final {
 int64_t sequence=0,timeInSamples=0,beat=0;
 double ppqPosition=0.0;
 int beatInBar=0;
 bool accent=false,preCount=false;
 int numerator=4,denominator=4;
};

/** Fixed-capacity audio-thread -> message-thread queue. No lock, allocation,
 * IPC, or UI work is performed by the real-time producer. */
class MetronomeTickQueue final {
public:
 static constexpr uint32_t capacity=64;
 bool push(MetronomeTick tick) noexcept {
  const auto write=write_.load(std::memory_order_relaxed);
  const auto next=(write+1u)%capacity;
  if(next==read_.load(std::memory_order_acquire)){dropped_.fetch_add(1,std::memory_order_relaxed);return false;}
  tick.sequence=++nextSequence_;
  events_[write]=tick;
  write_.store(next,std::memory_order_release);
  return true;
 }
 bool pop(MetronomeTick& tick) noexcept {
  const auto read=read_.load(std::memory_order_relaxed);
  if(read==write_.load(std::memory_order_acquire))return false;
  tick=events_[read];
  read_.store((read+1u)%capacity,std::memory_order_release);
  return true;
 }
 uint64_t dropped() const noexcept{return dropped_.load(std::memory_order_acquire);}
private:
 std::array<MetronomeTick,capacity> events_{};
 std::atomic<uint32_t> read_{0},write_{0};
 std::atomic<uint64_t> dropped_{0};
 int64_t nextSequence_=0; // producer-thread only
};

/** Select the nearest sample to a beat boundary, a beat being
 * `beatQuarters` long (an eighth in 6/8). `beat` counts those beats from zero.
 * The half-sample window deliberately permits one candidate on either side;
 * the engine's minimum-distance guard collapses a mathematical tie to one
 * audible click. */
inline bool metronomeBeatAtSample(double ppq,double quarterNotesPerSample,int64_t& beat,
                                  double beatQuarters=1.0) noexcept {
 if(!std::isfinite(ppq)||!std::isfinite(quarterNotesPerSample)||quarterNotesPerSample<=0)return false;
 if(!std::isfinite(beatQuarters)||beatQuarters<=0)return false;
 beat=(int64_t)std::llround(ppq/beatQuarters);
 return std::abs(ppq-(double)beat*beatQuarters)<=quarterNotesPerSample*0.51;
}

inline int64_t metronomePreCountSamples(double quarterNotesPerSample,
                                        int beats,double beatQuarters=1.0) noexcept {
 if(!std::isfinite(quarterNotesPerSample)||quarterNotesPerSample<=0||beats<=0)return 0;
 if(!std::isfinite(beatQuarters)||beatQuarters<=0)return 0;
 return (int64_t)std::ceil((double)beats*beatQuarters/quarterNotesPerSample);
}

inline bool metronomePreCountBeatAtSample(int64_t sampleOffset,
                                          double quarterNotesPerSample,
                                          int beats,
                                          int64_t& beat,
                                          double beatQuarters=1.0) noexcept {
 if(sampleOffset<0||beats<=0)return false;
 return metronomeBeatAtSample((double)sampleOffset*quarterNotesPerSample,
                              quarterNotesPerSample,beat,beatQuarters)
     && beat>=0&&beat<beats;
}
class Transport final : public juce::AudioPlayHead {
public:
 static constexpr double kDefaultBpm=120.0,kMinBpm=20.0,kMaxBpm=300.0;
 void setSampleRate(double v) noexcept { sampleRate_.store(std::isfinite(v)&&v>0?v:48000.0); }
 void setBpm(double v) noexcept { if(std::isfinite(v))bpm_.store(juce::jlimit(kMinBpm,kMaxBpm,v)); }
 static constexpr int kMaxMeterRegions=257;
 /** The project's signature map (D-061), from the message thread only.
  * Refused whole when it is not one -- a first region not at 0, positions not
  * rising, a signature that is not one -- and the last good map kept.
  * Published as a sequence lock: the audio thread never waits, it reads again
  * in the rare block that overlapped a write. */
 bool setMeter(const MeterRegion* regions,int count) noexcept {
  if(regions==nullptr||count<1||count>kMaxMeterRegions||regions[0].startPpq!=0.0)return false;
  for(int i=0;i<count;++i){
   if(!TimeSig::valid(regions[i].sig.numerator,regions[i].sig.denominator)||!std::isfinite(regions[i].startPpq))return false;
   if(i>0&&regions[i].startPpq<=regions[i-1].startPpq)return false;
  }
  const auto version=meterVersion_.load(std::memory_order_relaxed);
  meterVersion_.store(version+1u,std::memory_order_relaxed);
  std::atomic_thread_fence(std::memory_order_release);
  for(int i=0;i<count;++i){meterStarts_[size_t(i)].store(regions[i].startPpq,std::memory_order_relaxed);meterSigs_[size_t(i)].store(regions[i].sig.pack(),std::memory_order_relaxed);}
  meterCount_.store(count,std::memory_order_relaxed);
  meterVersion_.store(version+2u,std::memory_order_release);
  return true;
 }
 /** One signature for the whole song. */
 bool setSignature(int numerator,int denominator) noexcept { const MeterRegion region{0.0,TimeSig{numerator,denominator}};return setMeter(&region,1); }
 /** The region holding `ppq`, and where the next one begins (infinity after the last). */
 MeterRegion meterAt(double ppq,double* nextStart=nullptr) const noexcept {
  MeterRegion found{};double next=std::numeric_limits<double>::infinity();
  for(int attempt=0;attempt<16;++attempt){
   const auto version=meterVersion_.load(std::memory_order_acquire);
   if(version&1u)continue;
   const int count=std::clamp(meterCount_.load(std::memory_order_relaxed),1,kMaxMeterRegions);
   MeterRegion candidate{meterStarts_[0].load(std::memory_order_relaxed),TimeSig::unpack(meterSigs_[0].load(std::memory_order_relaxed))};
   double candidateNext=std::numeric_limits<double>::infinity();
   for(int i=1;i<count;++i){
    const double start=meterStarts_[size_t(i)].load(std::memory_order_relaxed);
    if(start<=ppq+1.0e-9)candidate={start,TimeSig::unpack(meterSigs_[size_t(i)].load(std::memory_order_relaxed))};
    else{candidateNext=start;break;}
   }
   std::atomic_thread_fence(std::memory_order_acquire);
   if(meterVersion_.load(std::memory_order_relaxed)==version){found=candidate;next=candidateNext;break;}
  }
  if(!TimeSig::valid(found.sig.numerator,found.sig.denominator))found.sig=TimeSig{};
  if(nextStart)*nextStart=next;
  return found;
 }
 /** Copy another transport's map, as the export's private transport does. */
 void copyMeterFrom(const Transport& other) noexcept {
  std::array<MeterRegion,kMaxMeterRegions> regions{};int count=0;double at=0.0;
  while(count<kMaxMeterRegions){double next=0.0;regions[size_t(count)]=other.meterAt(at,&next);++count;if(!std::isfinite(next))break;at=next;}
  setMeter(regions.data(),count);
 }
 /** The signature where the playhead is. */
 TimeSig signature() const noexcept { return meterAt(ppqPosition()).sig; }
 // The signature this block starts in, and where it began, fixed by
 // beginBlock like its tempo: a plugin reads one answer for the whole block.
 TimeSig blockSignature() const noexcept { return TimeSig::unpack(blockSignature_.load(std::memory_order_relaxed)); }
 double blockMeterStart() const noexcept { return blockMeterStart_.load(std::memory_order_relaxed); }
 void setPlaying(bool v) noexcept { playing_.store(v,std::memory_order_release); }
 void setRecording(bool v) noexcept { recording_.store(v,std::memory_order_release); }
 void seekPpq(double v) noexcept { if(!std::isfinite(v))return;const auto q=std::max(0.0,v);ppq_.store(q);samples_.store((int64_t)std::llround(q*60.0*sampleRate_.load()/bpm_.load()));seekSerial_.fetch_add(1); }
 void setLoop(bool enabled,double start,double end) noexcept { if(!std::isfinite(start)||!std::isfinite(end))return;start=std::max(0.0,start);end=std::max(start+0.03125,end);loopStart_.store(start);loopEnd_.store(end);loopEnabled_.store(enabled); }
 double bpm() const noexcept { return bpm_.load(); }
 double sampleRate() const noexcept { return sampleRate_.load(); }
 bool playing() const noexcept { return playing_.load(std::memory_order_acquire); }
 bool recording() const noexcept { return recording_.load(std::memory_order_acquire); }
 bool loopEnabled() const noexcept { return loopEnabled_.load(); }
 double loopStart() const noexcept { return loopStart_.load(); }
 double loopEnd() const noexcept { return loopEnd_.load(); }
 uint64_t seekSerial() const noexcept { return seekSerial_.load(); }
 bool processingPlaying() const noexcept { return blockPlaying_.load(std::memory_order_relaxed); }
 int64_t samplePosition() const noexcept { return samples_.load(); }
 double ppqPosition() const noexcept { return ppq_.load(); }
 double quarterNotesPerSample() const noexcept { return blockBpm_.load()/(60.0*sampleRate_.load()); }
 void beginBlock() noexcept { blockBpm_.store(bpm()); const auto region=meterAt(ppq_.load()); blockSignature_.store(region.sig.pack(),std::memory_order_relaxed); blockMeterStart_.store(region.startPpq,std::memory_order_relaxed); blockPlaying_.store(playing()); blockSerial_.fetch_add(1, std::memory_order_relaxed); }
 // Which block this is: what one node leaves for another is only good for the block it was left in.
 uint64_t blockSerial() const noexcept { return blockSerial_.load(std::memory_order_relaxed); }
 double ppqAtSample(int offset) const noexcept { const double from=ppqPosition();return loopedPpq(from,from+std::max(0,offset)*quarterNotesPerSample()); }
 void advance(int n) noexcept { if(!processingPlaying()||n<=0)return; samples_.fetch_add(n);const double from=ppq_.load();ppq_.store(loopedPpq(from,from+double(n)*blockBpm_.load()/(60.0*sampleRate_.load()))); }
 /** Where playing on from `from` to `to` lands. The loop folds only a playhead
  *  that CROSSES its end: one already past it plays on, as in other DAWs. Folding
  *  from anywhere past the end threw a playhead at bar 20 to some point inside a
  *  bar 1-4 loop the moment Loop was ticked, with every note it held left on. */
 double loopedPpq(double from,double to) const noexcept { if(!loopEnabled())return to;const auto a=loopStart(),b=loopEnd(),length=b-a;if(length<=0||from>=b-1.0e-12||to<b-1.0e-12)return to;double q=a+std::fmod(std::max(0.0,to-a),length);if(q>=b-1.0e-12)q=a;return q; }
 juce::Optional<PositionInfo> getPosition() const override { PositionInfo i; const auto meter=blockSignature(); TimeSignature signature; signature.numerator=meter.numerator; signature.denominator=meter.denominator;LoopPoints points;points.ppqStart=loopStart();points.ppqEnd=loopEnd(); const auto samples=samplePosition(); const auto ppq=ppqPosition(); i.setBpm(blockBpm_.load()); i.setTimeSignature(signature); i.setIsPlaying(processingPlaying()); i.setIsRecording(recording()); i.setIsLooping(loopEnabled());i.setLoopPoints(points);i.setTimeInSamples(samples); i.setTimeInSeconds(double(samples)/sampleRate_.load()); i.setPpqPosition(ppq); const double bar=meter.barQuarters(); const double from=blockMeterStart(); i.setPpqPositionOfLastBarStart(from+std::floor(std::max(0.0,ppq-from)/bar+1.0e-9)*bar); return i; }
private:
 std::atomic<double> bpm_{kDefaultBpm},sampleRate_{48000.0},ppq_{0.0},blockBpm_{kDefaultBpm};
 std::atomic<uint64_t> blockSerial_{0};
 std::atomic<uint32_t> blockSignature_{TimeSig{}.pack()};
 std::atomic<double> blockMeterStart_{0.0};
 std::array<std::atomic<double>,kMaxMeterRegions> meterStarts_{};
 std::array<std::atomic<uint32_t>,kMaxMeterRegions> meterSigs_{};
 std::atomic<int> meterCount_{1};
 std::atomic<uint32_t> meterVersion_{0};
 std::atomic<int64_t> samples_{0}; std::atomic<bool> playing_{false},blockPlaying_{false},recording_{false},loopEnabled_{false};
 std::atomic<double> loopStart_{0.0},loopEnd_{16.0};std::atomic<uint64_t> seekSerial_{0};
};

/** Stable playhead object installed once on every plugin. The audio callback
 * selects either the live clock or the private export clock before processing
 * a block, so VSTs never receive timing from the wrong transport. */
class TransportPlayHeadRouter final : public juce::AudioPlayHead {
public:
 void select(Transport& transport) noexcept { selected_.store(&transport,std::memory_order_release); }
 juce::Optional<PositionInfo> getPosition() const override {
  if(auto* transport=selected_.load(std::memory_order_acquire))return transport->getPosition();
  return {};
 }
private:
 std::atomic<Transport*> selected_{nullptr};
};
}
