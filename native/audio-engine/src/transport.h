#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
namespace mlh {
inline float metronomeClickPhaseIncrement(bool accent, bool preCount) noexcept
{
 const float normal = accent ? 0.42f : 0.31f;
 return normal * (preCount ? 1.25f : 1.0f);
}

struct MetronomeTick final {
 int64_t sequence=0,timeInSamples=0,beat=0;
 double ppqPosition=0.0;
 int beatInBar=0;
 bool accent=false,preCount=false;
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

/** Select the nearest sample to a quarter-note boundary. The half-sample
 * window deliberately permits one candidate on either side; the engine's
 * minimum-distance guard collapses a mathematical tie to one audible click. */
inline bool metronomeBeatAtSample(double ppq,double quarterNotesPerSample,int64_t& beat) noexcept {
 if(!std::isfinite(ppq)||!std::isfinite(quarterNotesPerSample)||quarterNotesPerSample<=0)return false;
 beat=(int64_t)std::llround(ppq);
 return std::abs(ppq-(double)beat)<=quarterNotesPerSample*0.51;
}

inline int64_t metronomePreCountSamples(double quarterNotesPerSample,
                                        int beats) noexcept {
 if(!std::isfinite(quarterNotesPerSample)||quarterNotesPerSample<=0||beats<=0)return 0;
 return (int64_t)std::ceil((double)beats/quarterNotesPerSample);
}

inline bool metronomePreCountBeatAtSample(int64_t sampleOffset,
                                          double quarterNotesPerSample,
                                          int beats,
                                          int64_t& beat) noexcept {
 if(sampleOffset<0||beats<=0)return false;
 return metronomeBeatAtSample((double)sampleOffset*quarterNotesPerSample,
                              quarterNotesPerSample,beat)
     && beat>=0&&beat<beats;
}
class Transport final : public juce::AudioPlayHead {
public:
 static constexpr double kDefaultBpm=120.0,kMinBpm=20.0,kMaxBpm=300.0;
 void setSampleRate(double v) noexcept { sampleRate_.store(std::isfinite(v)&&v>0?v:48000.0); }
 void setBpm(double v) noexcept { if(std::isfinite(v))bpm_.store(juce::jlimit(kMinBpm,kMaxBpm,v)); }
 void setPlaying(bool v) noexcept { playing_.store(v,std::memory_order_release); }
 void setRecording(bool v) noexcept { recording_.store(v,std::memory_order_release); }
 void seekPpq(double v) noexcept { if(!std::isfinite(v))return;const auto q=std::max(0.0,v);ppq_.store(q);samples_.store((int64_t)std::llround(q*60.0*sampleRate_.load()/bpm_.load()));seekSerial_.fetch_add(1); }
 void setLoop(bool enabled,double start,double end) noexcept { if(!std::isfinite(start)||!std::isfinite(end))return;start=std::max(0.0,start);end=std::max(start+0.03125,end);loopStart_.store(start);loopEnd_.store(end);loopEnabled_.store(enabled); }
 double bpm() const noexcept { return bpm_.load(); }
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
 void beginBlock() noexcept { blockBpm_.store(bpm()); blockPlaying_.store(playing()); }
 double ppqAtSample(int offset) const noexcept { double q=ppqPosition()+std::max(0,offset)*quarterNotesPerSample();if(loopEnabled()){const auto a=loopStart(),b=loopEnd(),length=b-a;if(length>0&&q>=b-1.0e-12){q=a+std::fmod(std::max(0.0,q-a),length);if(q>=b-1.0e-12)q=a;}}return q; }
 void advance(int n) noexcept { if(!processingPlaying()||n<=0)return; samples_.fetch_add(n);double q=ppq_.load()+double(n)*blockBpm_.load()/(60.0*sampleRate_.load());if(loopEnabled()){const auto a=loopStart(),b=loopEnd(),length=b-a;if(length>0&&q>=b-1.0e-12){q=a+std::fmod(std::max(0.0,q-a),length);if(q>=b-1.0e-12)q=a;}}ppq_.store(q); }
 juce::Optional<PositionInfo> getPosition() const override { PositionInfo i; TimeSignature signature; signature.numerator=4; signature.denominator=4;LoopPoints points;points.ppqStart=loopStart();points.ppqEnd=loopEnd(); const auto samples=samplePosition(); const auto ppq=ppqPosition(); i.setBpm(blockBpm_.load()); i.setTimeSignature(signature); i.setIsPlaying(processingPlaying()); i.setIsRecording(recording()); i.setIsLooping(loopEnabled());i.setLoopPoints(points);i.setTimeInSamples(samples); i.setTimeInSeconds(double(samples)/sampleRate_.load()); i.setPpqPosition(ppq); i.setPpqPositionOfLastBarStart(std::floor(ppq/4.0)*4.0); return i; }
private:
 std::atomic<double> bpm_{kDefaultBpm},sampleRate_{48000.0},ppq_{0.0},blockBpm_{kDefaultBpm};
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
